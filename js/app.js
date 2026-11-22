// Главный модуль: экраны, навигация, синхронизация с Google Диском, обложки.
import { state, load, save, persist, setSetting, subscribe, allTags, itemsWithTag, exportSyncData, mergeSyncData, annotationsOf, liveCollections, putCollection, uid, isFavorite, setFavorite, seedShelves, liveShelves, addShelf, renameShelf, deleteShelf, shelvesOf, setBookShelves, booksOnShelf, applyMeta, applyAllMeta, setBookMeta } from './store.js';
import { db, requestPersistence } from './db.js';
import * as drive from './drive.js';
import { openBook, bookInfo, resizeImage } from './formats.js';
import { Reader, annCard, ico } from './reader.js';
import { esc, $, $$, h, toast, sheet, confirmSheet, fallbackCover, fmtDate, excerpt } from './ui.js';

const app = document.getElementById('app');
let reader = null;
let navDepth = 0;
const coverUrls = new Map();
let syncing = false;

// ---------------- Запуск ----------------
async function start() {
  await load();
  seedShelves();
  applyAllMeta();
  document.documentElement.dataset.theme = state.settings.theme;
  requestPersistence();
  window.addEventListener('hashchange', () => { navDepth++; route(); });
  subscribe((what) => { if (['annotations', 'progress', 'favorites', 'shelves', 'bookmeta'].includes(what)) scheduleNotesSync(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { reader && reader.savePosition(); persist(); if (state.dirty) syncNotes().catch(() => {}); }
  });
  route();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  // При запуске — тихая синхронизация, если вход ещё действителен
  if (drive.isConfigured() && drive.hasValidToken() && state.settings.rootFolderId) syncAll().catch(e => console.warn(e));
}

// ---------------- Навигация ----------------
function go(hash) { location.hash = hash; }
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query] = raw.split('?');
  const parts = path.split('/').map(decodeURIComponent);
  const params = new URLSearchParams(query || '');
  return { parts, params };
}
async function route() {
  const { parts, params } = parseHash();
  if (reader && parts[0] !== 'read') { reader.destroy(); reader = null; }
  $$('.sheet-wrap').forEach(s => s.remove());
  document.body.classList.toggle('reading', parts[0] === 'read' || (parts[0] === 's' && parts[2] === 'read'));
  switch (parts[0]) {
    case 'cat': return renderCategory(parts[1], parts[2] || null);
    case 'col': return renderCollection(parts[1]);
    case 'shelf': return renderShelf(parts[1]);
    case 's': return routeGuest(parts);
    case 'tags': return renderHome('tags');
    case 'tag': return renderTag(parts[1], params.get('f') || 'all');
    case 'read': return openReader(parts[1], params.get('a'));
    case 'settings': return renderSettings();
    default: return renderHome('library');
  }
}
function back(fallback = '#/') { if (navDepth > 0) history.back(); else go(fallback); }

// ---------------- Обложки ----------------
async function coverUrl(id) {
  if (coverUrls.has(id)) return coverUrls.get(id);
  const blob = await db.get('covers', id).catch(() => null);
  const url = blob ? URL.createObjectURL(blob) : null;
  coverUrls.set(id, url);
  return url;
}
async function fillCovers(root) {
  for (const el of $$('[data-cover]', root)) {
    const id = el.dataset.cover;
    const url = await coverUrl(id);
    if (url) el.innerHTML = `<img src="${url}" alt="" loading="lazy">`;
  }
}
const coverQueue = [];
let coverBusy = false;
function queueCovers(ids) {
  for (const id of ids) {
    const b = state.books[id];
    if (b && !b.coverTried && !coverQueue.includes(id)) coverQueue.push(id);
  }
  runCoverQueue();
}
async function runCoverQueue() {
  if (coverBusy) return;
  coverBusy = true;
  try {
    while (coverQueue.length) {
      const id = coverQueue.shift();
      const b = state.books[id];
      if (!b || b.coverTried) continue;
      let blob = await db.get('files', id).catch(() => null);
      if (!blob && b.source === 'drive') {
        if (!state.settings.autoCovers || !drive.hasValidToken()) continue;
        if (b.size > 80 * 1024 * 1024) { b.coverTried = true; continue; }
        try { blob = await drive.download(b.driveId, b.size); await db.set('files', id, blob); }
        catch (e) { console.warn(e); continue; }
      }
      if (!blob) continue;
      const info = await bookInfo(blob, b.format);
      b.coverTried = true;
      if (info.title && info.title.length > 1) b.title = info.title;
      if (info.author) b.author = info.author;
      applyMeta(b);
      if (info.cover) {
        await db.set('covers', id, info.cover);
        coverUrls.delete(id);
        const url = await coverUrl(id);
        $$(`[data-cover="${CSS.escape(id)}"]`).forEach(el => { el.innerHTML = `<img src="${url}" alt="">`; });
      }
      $$(`[data-title="${CSS.escape(id)}"]`).forEach(el => { el.textContent = b.title; });
      $$(`[data-author="${CSS.escape(id)}"]`).forEach(el => { el.textContent = b.author || ''; });
      save('books', { sync: false });
    }
  } finally { coverBusy = false; }
}

// ---------------- Главный экран ----------------
function categories() {
  const map = new Map();
  for (const b of Object.values(state.books)) {
    if (!map.has(b.category)) map.set(b.category, []);
    map.get(b.category).push(b);
  }
  return [...map.entries()].sort((a, b) => {
    const order = (n) => n === 'Без категории' ? 2 : n === 'На устройстве' ? 3 : 1;
    return order(a[0]) - order(b[0]) || a[0].localeCompare(b[0], 'ru');
  });
}
function topBar(title, { backBtn = false, right = '' } = {}) {
  return `<header class="topbar">${backBtn ? `<button class="icon-btn" data-back>${ico('back')}</button>` : ''}<h1>${esc(title)}</h1><div class="spacer"></div>${right}</header>`;
}
function bottomNav(active) {
  return `<nav class="bottomnav">
    <a href="#/" class="${active === 'library' ? 'on' : ''}">${ico('book')}<span>Книги</span></a>
    <a href="#/tags" class="${active === 'tags' ? 'on' : ''}">${ico('tag')}<span>Теги</span></a>
  </nav>`;
}
function syncBtn() {
  const pending = state.dirty && drive.isConfigured();
  return `<button class="icon-btn ${syncing ? 'spin' : ''} ${pending ? 'pending' : ''}" data-sync aria-label="Синхронизировать">${ico('sync')}</button>`;
}
function bindCommon(root, backFallback = '#/') {
  root.querySelector('[data-back]')?.addEventListener('click', () => back(backFallback));
  root.querySelectorAll('[data-sync]').forEach(b => b.addEventListener('click', () => syncAll({ interactive: true }).catch(err => toast(err.message))));
  root.querySelector('[data-settings]')?.addEventListener('click', () => go('#/settings'));
}

let homeQuery = '';
function renderHome(tab) {
  if (tab === 'tags') return renderTags();
  const cats = categories();
  const last = state.lastOpened && state.books[state.lastOpened];
  const empty = !cats.length;
  const homeTab = state.settings.homeTab === 'folders' ? 'folders' : 'shelves';
  const favs = Object.values(state.books).filter(b => isFavorite(b.id))
    .sort((a, b) => (state.progress[b.id]?.t || 0) - (state.progress[a.id]?.t || 0));
  const actions = `<div class="hz-actions">${syncBtn()}<button class="icon-btn" data-settings aria-label="Настройки">${ico('gear')}</button></div>`;

  if (empty) {
    app.innerHTML = `
      <div class="home">
        <header class="hz-top"><div class="hz-current"></div>${actions}</header>
        <div class="welcome">
          <div class="welcome-ico">${ico('book')}</div>
          <h2>Здесь появятся ваши книги</h2>
          <p>Подключите папку на Google Диске: каждая подпапка станет категорией. Или добавьте файл с устройства.</p>
          <button class="btn primary" data-settings>Подключить Google Диск</button>
          <button class="btn ghost" data-import>Добавить файл с устройства</button>
        </div>
        ${bottomNav('library')}
      </div>`;
    bindCommon(app);
    $$('[data-import]', app).forEach(b => b.onclick = importLocal);
    return;
  }

  const listHtml = homeTab === 'shelves' ? shelvesGridHtml(liveShelves()) : `<div class="cat-grid">
      ${cats.map(([name, books]) => `<a class="cat-tile" href="#/cat/${encodeURIComponent(name)}">
          <div class="cat-name">${esc(name)}</div><div class="cat-count">${books.length}</div>
        </a>`).join('')}
    </div>`;

  app.innerHTML = `
    <div class="home">
      <header class="hz-top">
        ${last ? `<a class="hz-current" href="#/read/${encodeURIComponent(last.id)}">
            <div class="hz-cover" data-cover="${esc(last.id)}">${fallbackCover(last.title, last.author, last.id)}</div>
            <div class="hz-cur-info"><div class="hz-cur-title">${esc(last.title)}</div>${last.author ? `<div class="hz-cur-author">${esc(last.author)}</div>` : ''}</div>
          </a>` : `<div class="hz-current hz-current-empty">Откройте книгу — она появится здесь</div>`}
        ${actions}
      </header>
      <div class="hz-body">
        <aside class="hz-side">
          ${favs.length ? `<nav class="fav-list">${favs.map(b => `<a class="fav-item" href="#/read/${encodeURIComponent(b.id)}">
              <div class="fav-cover" data-cover="${esc(b.id)}">${fallbackCover(b.title, '', b.id)}</div>
              <div class="fav-title">${esc(b.title)}</div>
            </a>`).join('')}</nav>`
            : `<p class="fav-empty">Отметьте галочку под обложкой — книга появится в этой колонке.</p>`}
        </aside>
        <section class="hz-main">
          <div class="search hz-search"><span>${ico('search')}</span><input type="search" id="bsearch" placeholder="Название или автор" autocomplete="off" value="${esc(homeQuery)}"></div>
          <div class="search-results" hidden></div>
          <div class="home-zones">
            <div class="hz-tabs" role="tablist">
              <button class="${homeTab === 'shelves' ? 'on' : ''}" data-htab="shelves" role="tab">Полки</button>
              <button class="${homeTab === 'folders' ? 'on' : ''}" data-htab="folders" role="tab">Папки на Диске</button>
            </div>
            ${listHtml}
            ${collectionsSection()}
          </div>
        </section>
      </div>
      <button class="fab" data-import aria-label="Добавить файл с устройства">${ico('plus')}</button>
      ${bottomNav('library')}
    </div>`;
  bindCommon(app);
  $$('[data-import]', app).forEach(b => b.onclick = importLocal);
  $$('[data-newcol]', app).forEach(b => b.onclick = () => openCollectionEditor(null));
  bindShelfButtons(app, () => renderHome('library'));
  $$('[data-htab]', app).forEach(t => t.onclick = () => { setSetting('homeTab', t.dataset.htab); renderHome('library'); });
  const si = $('#bsearch', app);
  const run = () => {
    homeQuery = si.value;
    const norm = (x) => x.toLowerCase().replace(/ё/g, 'е');
    const q = norm(si.value.trim());
    const res = $('.search-results', app), zones = $('.home-zones', app);
    if (!q) { res.hidden = true; zones.hidden = false; return; }
    const words = q.split(/\s+/);
    const found = Object.values(state.books).filter(b => {
      const hay = norm(b.title + ' ' + (b.author || '') + ' ' + (b.fileName || ''));
      return words.every(w => hay.includes(w));
    }).sort((a, b) => a.title.localeCompare(b.title, 'ru', { numeric: true })).slice(0, 200);
    res.innerHTML = found.length
      ? `<div class="book-grid">${found.map(bookCardHtml).join('')}</div>`
      : `<div class="empty-state">Ничего не найдено</div>`;
    res.hidden = false; zones.hidden = true;
    bindBookCards(res, run);
    fillCovers(res);
    queueCovers(found.slice(0, 40).map(b => b.id));
  };
  si.addEventListener('input', run);
  if (homeQuery) run();
  fillCovers(app);
  queueCovers(favs.concat(last ? [last] : []).map(b => b.id));
}

function catHash(cat, sub) {
  return '#/cat/' + encodeURIComponent(cat) + (sub ? '/' + encodeURIComponent(sub) : '');
}
const catFolder = (cat) => Object.values(state.folders || {}).find(f => f.cat === cat && !f.sub);
const subFolder = (cat, sub) => Object.values(state.folders || {}).find(f => f.cat === cat && f.sub === sub);
function subcategoriesOf(cat) {
  const names = new Set(Object.values(state.folders || {}).filter(f => f.cat === cat && f.sub).map(f => f.sub));
  for (const b of Object.values(state.books)) if (b.category === cat && b.sub) names.add(b.sub);
  return [...names].sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }));
}

function bookCardHtml(b) {
  const pct = state.progress[b.id]?.pct;
  return `<div class="book-item"><a class="book-card" href="#/read/${encodeURIComponent(b.id)}" data-id="${esc(b.id)}">
    <div class="cover" data-cover="${esc(b.id)}">${fallbackCover(b.title, b.author, b.id)}</div>
    <div class="bk-title" data-title="${esc(b.id)}">${esc(b.title)}</div>
    <div class="bk-author" data-author="${esc(b.id)}">${esc(b.author || '')}</div>
    <button class="card-menu" data-menu="${esc(b.id)}" aria-label="Полки и действия">⋯</button>
    ${shelvesOf(b.id).length ? `<div class="bk-shelves">${shelvesOf(b.id).length} ${plural(shelvesOf(b.id).length, 'полка', 'полки', 'полок')}</div>` : ''}
  </a><label class="fav-check"><input type="checkbox" data-fav="${esc(b.id)}" ${isFavorite(b.id) ? 'checked' : ''}><span>Читаю</span></label></div>`;
}

function renderCategory(name, sub = null) {
  const inCat = Object.values(state.books).filter(b => b.category === name);
  const books = inCat.filter(b => (b.sub || null) === sub)
    .sort((a, b) => a.title.localeCompare(b.title, 'ru', { numeric: true }));
  const subs = sub ? [] : subcategoriesOf(name);
  const canSub = !sub && !!catFolder(name);
  const title = sub || name;
  app.innerHTML = `
    <div class="screen">
      ${topBar(title, { backBtn: true, right: syncBtn() })}
      <main class="content">
        ${sub ? `<div class="crumb"><a href="${catHash(name)}">${esc(name)}</a> › ${esc(sub)}</div>` : ''}
        ${subs.length || canSub ? `<h2 class="section-title">Подкатегории</h2>
          <div class="sub-grid">
            ${subs.map(sname => {
              const n = inCat.filter(b => b.sub === sname).length;
              return `<a class="sub-tile" href="${catHash(name, sname)}">${ico('folder')}<span class="sub-name">${esc(sname)}</span><span class="sub-count">${n}</span></a>`;
            }).join('')}
            ${canSub ? `<button class="sub-tile add" data-newsub>${ico('plus')}<span class="sub-name">Подкатегория</span></button>` : ''}
          </div>
          ${books.length ? '<h2 class="section-title">Книги</h2>' : ''}` : ''}
        ${books.length ? `<div class="book-grid">${books.map(bookCardHtml).join('')}</div>`
          : `<div class="empty-state">${sub ? 'В этой подкатегории пока нет книг. Перенесите сюда книги кнопкой «⋯» на обложке.' : subs.length ? '' : 'В этой категории пока нет книг'}</div>`}
      </main>
    </div>`;
  bindCommon(app, sub ? catHash(name) : '#/');
  bindBookCards(app, () => renderCategory(name, sub));
  const ns = $('[data-newsub]', app);
  if (ns) ns.onclick = () => openNewSubSheet(name);
  fillCovers(app);
  queueCovers(books.map(b => b.id));
}

function openNewSubSheet(cat) {
  const sh = sheet(`
    <h3>Новая подкатегория</h3>
    <p class="sheet-text">Внутри «${esc(cat)}» появится подкатегория — и такая же папка на вашем Google Диске.</p>
    <label class="field"><span>Название</span><input id="sname" placeholder="Например: «Конспекты»"></label>
    <div class="sheet-actions"><button class="btn ghost" data-close>Отмена</button><button class="btn primary" id="screate">Создать</button></div>`);
  const input = $('#sname', sh.el);
  setTimeout(() => input.focus(), 250);
  const create = async () => {
    const nm = input.value.trim();
    if (!nm) { toast('Введите название'); return; }
    if (subcategoriesOf(cat).includes(nm)) { toast('Такая подкатегория уже есть'); return; }
    const btn = $('#screate', sh.el); btn.disabled = true; btn.textContent = 'Создаю…';
    try {
      await ensureSignedIn(true);
      const parent = catFolder(cat);
      const f = await drive.createFolder(nm, parent.id);
      state.folders[f.id] = { id: f.id, name: nm, cat, sub: nm };
      save('books', { sync: false });
      sh.close();
      toast('Подкатегория создана');
      renderCategory(cat);
    } catch (e) { toast(e.message, 5000); btn.disabled = false; btn.textContent = 'Создать'; }
  };
  $('#screate', sh.el).onclick = create;
  input.onkeydown = (e) => { if (e.key === 'Enter') create(); };
}

function openMoveSheet(b, after) {
  if (!b) return;
  const dests = [];
  if (state.settings.rootFolderId) dests.push({ id: state.settings.rootFolderId, cat: 'Без категории', sub: null, label: 'Без категории' });
  for (const f of Object.values(state.folders || {})) dests.push({ id: f.id, cat: f.cat, sub: f.sub, label: f.sub ? `${f.cat} › ${f.sub}` : f.cat });
  dests.sort((x, y) => {
    if (x.cat === b.category && y.cat !== b.category) return -1;
    if (y.cat === b.category && x.cat !== b.category) return 1;
    return x.label.localeCompare(y.label, 'ru', { numeric: true });
  });
  const here = (d) => d.cat === b.category && (d.sub || null) === (b.sub || null);
  const sh = sheet(`
    <h3>Переместить книгу</h3>
    <p class="sheet-text">«${esc(b.title)}». Книга переместится и в папках вашего Google Диска.</p>
    <div class="folder-list">${dests.map((d, i) => `<button class="folder ${d.sub ? 'is-sub' : ''}" data-i="${i}" ${here(d) ? 'disabled' : ''}>${ico('folder')} ${esc(d.label)}${here(d) ? ' <small>(сейчас здесь)</small>' : ''}</button>`).join('')}</div>
    <div class="sheet-actions"><button class="btn ghost" data-close>Отмена</button></div>`, { cls: 'tall' });
  $('.folder-list', sh.el).onclick = async (e) => {
    const btn = e.target.closest('[data-i]'); if (!btn || btn.disabled) return;
    const d = dests[+btn.dataset.i];
    btn.disabled = true;
    try {
      await ensureSignedIn(true);
      await drive.moveFile(b.id, d.id, b.parentId);
      b.parentId = d.id; b.category = d.cat; b.sub = d.sub || null;
      save('books', { sync: false });
      sh.close();
      toast(`Перемещено: ${d.label}`);
      after && after();
    } catch (err) { toast(err.message, 5000); btn.disabled = false; }
  };
}

// ---------------- Теги ----------------
function renderTags() {
  const tags = allTags();
  app.innerHTML = `
    <div class="screen">
      ${topBar('Теги', { right: syncBtn() })}
      <main class="content">
        ${tags.length ? `
          <div class="search"><span>${ico('search')}</span><input type="search" placeholder="Найти тег" id="tq"></div>
          <ul class="tag-list">${tags.map(([t, n]) => {
            const items = itemsWithTag(t);
            const nh = items.filter(a => a.type === 'hl').length, nc = items.filter(a => a.type === 'cm').length;
            return `<li><a href="#/tag/${encodeURIComponent(t)}" data-t="${esc(t.toLowerCase())}"><span class="tag-name">#${esc(t)}</span>
              <span class="tag-counts">${nh ? `${nh} ${plural(nh, 'заметка', 'заметки', 'заметок')}` : ''}${nh && nc ? ' · ' : ''}${nc ? `${nc} ${plural(nc, 'комментарий', 'комментария', 'комментариев')}` : ''}</span></a></li>`;
          }).join('')}</ul>` : `<div class="welcome"><div class="welcome-ico">${ico('tag')}</div><h2>Тегов пока нет</h2>
            <p>Нажмите на выделенный текст или комментарий в книге и добавьте тег — он появится здесь.</p></div>`}
      </main>
      ${bottomNav('tags')}
    </div>`;
  bindCommon(app);
  const q = $('#tq', app);
  if (q) q.oninput = () => { const v = q.value.trim().toLowerCase().replace(/^#/, ''); $$('.tag-list li', app).forEach(li => { li.hidden = v && !li.firstElementChild.dataset.t.includes(v); }); };
}
function renderTag(tag, filter) {
  const all = itemsWithTag(tag);
  const items = all.filter(a => filter === 'all' || (filter === 'hl' ? a.type === 'hl' : a.type === 'cm'));
  const title = (a) => state.books[a.bookId]?.title || state.bookTitles[a.bookId] || 'Книга';
  app.innerHTML = `
    <div class="screen">
      ${topBar('#' + tag, { backBtn: true })}
      <main class="content">
        <div class="seg">
          <a href="#/tag/${encodeURIComponent(tag)}?f=all" class="${filter === 'all' ? 'on' : ''}">Всё · ${all.length}</a>
          <a href="#/tag/${encodeURIComponent(tag)}?f=hl" class="${filter === 'hl' ? 'on' : ''}">Заметки</a>
          <a href="#/tag/${encodeURIComponent(tag)}?f=cm" class="${filter === 'cm' ? 'on' : ''}">Комментарии</a>
        </div>
        <div class="ann-list">${items.map(a => annCard(a, title(a))).join('') || '<div class="empty-state">Ничего нет</div>'}</div>
      </main>
    </div>`;
  bindCommon(app);
  $('.ann-list', app).onclick = (e) => {
    const card = e.target.closest('.ann-card'); if (!card) return;
    const a = state.annotations[card.dataset.id];
    if (!state.books[a.bookId]) { toast('Этой книги сейчас нет в библиотеке'); return; }
    go(`#/read/${encodeURIComponent(a.bookId)}?a=${a.id}`);
  };
}

// ---------------- Чтение ----------------
async function openReader(id, annId) {
  const meta = state.books[id];
  if (!meta) { app.innerHTML = `<div class="screen">${topBar('Книга', { backBtn: true })}<div class="empty-state">Книга не найдена. Попробуйте синхронизировать библиотеку.</div></div>`; bindCommon(app); return; }
  await openReaderWith({
    meta, annId, mode: 'full',
    onBack: () => back(catHash(meta.category, meta.sub)),
    getBlob: async (progress) => {
      if (meta.source !== 'drive') throw new Error('Файл книги не найден на устройстве');
      if (!drive.hasValidToken()) {
        $('.lt', app).textContent = 'Нужно войти в Google, чтобы скачать книгу';
        const btn = h('<button class="btn primary">Войти через Google</button>');
        $('.lp', app).replaceWith(btn);
        await new Promise((res, rej) => { btn.onclick = () => drive.signIn().then(res, rej); });
        btn.replaceWith(h('<div class="lp"></div>'));
        $('.lt', app).textContent = `Открываю «${meta.title}»`;
      }
      return drive.download(meta.driveId, meta.size, progress);
    },
    afterOpen: (book) => {
      if (!meta.coverTried) queueCovers([id]);
      if (book.title && (meta.title === drive.cleanTitle(meta.fileName || '') || !meta.title)) meta.title = book.title;
      if (book.author && !meta.author) meta.author = book.author;
      applyMeta(meta);
      state.lastOpened = id;
    },
  });
}

// Общая логика открытия книги (своей или гостевой)
async function openReaderWith({ meta, annId, mode, ownerAnns = null, onBack, getBlob, afterOpen }) {
  const id = meta.id;
  const findAnn = (aid) => ownerAnns ? ownerAnns.find(a => a.id === aid) : state.annotations[aid];
  if (reader && reader.bookId === id) { if (annId) reader.goToAnnotation(findAnn(annId)); return; }
  if (reader) { reader.destroy(); reader = null; }
  const startHash = location.hash.split('?')[0];
  app.innerHTML = `<div class="loading-screen"><div class="spinner"></div><div class="lt">Открываю «${esc(meta.title)}»</div><div class="lp"></div><button class="btn ghost" data-back>Отмена</button></div>`;
  bindCommon(app);
  let cancelled = false;
  $('[data-back]', app).addEventListener('click', () => { cancelled = true; });
  try {
    let blob = await db.get('files', id).catch(() => null);
    if (!blob) {
      blob = await getBlob(p => { const el = $('.lp', app); if (el) el.textContent = `Скачиваю… ${Math.round(p * 100)}%`; });
      await db.set('files', id, blob);
    }
    if (cancelled) return;
    $('.lp', app) && ($('.lp', app).textContent = 'Готовлю страницы…');
    const book = await openBook(blob, meta.format);
    if (cancelled || location.hash.split('?')[0] !== startHash) { book.dispose && book.dispose(); return; }
    afterOpen && afterOpen(book);
    state.bookTitles[id] = meta.title;
    save('books', { sync: false });
    app.innerHTML = '<div class="reader-host"></div>';
    reader = new Reader($('.reader-host', app), book, meta, { onBack, mode, ownerAnns });
    await reader.mount();
    if (annId && findAnn(annId)) await reader.goToAnnotation(findAnn(annId));
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="screen">${topBar(meta.title, { backBtn: true })}<div class="empty-state error">Не удалось открыть книгу.<br><small>${esc(e.message)}</small></div></div>`;
    bindCommon(app);
  }
}

// ---------------- Добавление файлов с устройства ----------------
function importLocal() {
  const input = h(`<input type="file" multiple accept=".epub,.pdf,.fb2,.zip,.txt,.mobi,.azw3,.azw,.prc,.docx,.cbz">`);
  input.style.display = 'none';
  document.body.appendChild(input);
  input.onchange = async () => {
    const files = [...input.files];
    input.remove();
    for (const f of files) {
      const format = drive.formatOf(f.name);
      if (!format) { toast(`Формат «${f.name}» не поддерживается`); continue; }
      const id = 'local:' + f.name + ':' + f.size;
      await db.set('files', id, f);
      state.books[id] = { id, source: 'local', format, fileName: f.name, title: drive.cleanTitle(f.name), author: '', category: 'На устройстве', size: f.size };
    }
    save('books', { sync: false });
    toast(files.length > 1 ? `Добавлено файлов: ${files.length}` : 'Книга добавлена');
    route();
  };
  input.click();
}

// ---------------- Синхронизация ----------------
async function ensureSignedIn(interactive) {
  if (!drive.isConfigured()) { if (interactive) { toast('Сначала настройте Google Диск'); go('#/settings'); } return false; }
  if (drive.hasValidToken()) return true;
  if (!interactive) return false;
  await drive.signIn();
  return true;
}
function setSyncing(on) {
  syncing = on;
  $$('[data-sync]').forEach(b => b.classList.toggle('spin', on));
}
export async function syncAll({ interactive = false } = {}) {
  if (syncing) return;
  if (!(await ensureSignedIn(interactive))) return;
  if (!state.settings.rootFolderId) { if (interactive) { toast('Выберите папку с книгами'); go('#/settings'); } return; }
  setSyncing(true);
  try {
    const { books: found, folders } = await drive.scanLibrary(state.settings.rootFolderId);
    state.folders = folders;
    const seen = new Set();
    for (const nb of found) {
      seen.add(nb.id);
      const old = state.books[nb.id];
      if (old && old.modifiedTime === nb.modifiedTime) {
        old.category = nb.category; old.sub = nb.sub; old.parentId = nb.parentId; old.fileName = nb.fileName;
        if (!old.coverTried) old.title = old.title || nb.title;
      } else {
        if (old) { await db.del('files', nb.id).catch(() => {}); await db.del('covers', nb.id).catch(() => {}); coverUrls.delete(nb.id); }
        state.books[nb.id] = nb;
      }
    }
    for (const b of Object.values(state.books)) {
      if (b.source === 'drive' && !seen.has(b.id)) {
        delete state.books[b.id];
        db.del('files', b.id).catch(() => {}); db.del('covers', b.id).catch(() => {});
      }
    }
    applyAllMeta();
    save('books', { sync: false });
    await syncNotes(true);
    toast(`Синхронизировано: ${found.length} ${plural(found.length, 'книга', 'книги', 'книг')}`);
    if (!reader) route();
  } catch (e) {
    if (e instanceof drive.AuthError) toast('Войдите в Google снова: нажмите кнопку синхронизации');
    else toast(e.message);
    throw e;
  } finally { setSyncing(false); }
}
let notesTimer;
function scheduleNotesSync() {
  clearTimeout(notesTimer);
  notesTimer = setTimeout(() => syncNotes().catch(() => {}), 8000);
}
let notesBusy = false;
async function syncNotes(force = false) {
  if (notesBusy || !drive.isConfigured() || !drive.hasValidToken()) return;
  if (!force && !state.dirty) return;
  notesBusy = true;
  try {
    const remote = await drive.readSyncData();
    const changed = mergeSyncData(remote);
    await drive.writeSyncData(exportSyncData());
    state.dirty = false;
    state.lastSync = Date.now();
    await persist();
    if (changed) applyAllMeta();
    if (changed && reader) reader.refreshAnnotations();
    republishOwnerNotes().catch(e => console.warn(e));
    $$('[data-sync]').forEach(b => b.classList.remove('pending'));
  } finally { notesBusy = false; }
}

// ---------------- Настройки ----------------
function renderSettings() {
  const s = state.settings;
  const connected = drive.hasValidToken();
  app.innerHTML = `
    <div class="screen">
      ${topBar('Настройки', { backBtn: true })}
      <main class="content settings">
        <section class="card">
          <h2>Google Диск</h2>
          <label class="field"><span>Client ID (ключ приложения из Google Cloud)</span>
            <input id="cid" value="${esc(s.clientId)}" placeholder="1234567890-xxxx.apps.googleusercontent.com" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
          <label class="field"><span>API-ключ (нужен, чтобы делиться подборками по ссылке)</span>
            <input id="akey" value="${esc(s.apiKey)}" placeholder="AIza…" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
          <div class="row"><button class="btn" id="saveCid">Сохранить ключи</button></div>
          <div class="status ${connected ? 'ok' : ''}">${connected ? 'Вход выполнен' : drive.wasConnected() ? 'Сессия истекла — войдите снова' : 'Не подключено'}</div>
          <div class="row">
            <button class="btn primary" id="signin" ${s.clientId ? '' : 'disabled'}>${connected ? 'Войти заново' : 'Войти через Google'}</button>
            ${drive.wasConnected() ? '<button class="btn ghost" id="signout">Выйти</button>' : ''}
          </div>
          <div class="field"><span>Папка с книгами</span>
            <div class="folder-current">${ico('folder')} ${s.rootFolderName ? esc(s.rootFolderName) : '<i>не выбрана</i>'}</div>
            <button class="btn" id="pick" ${connected ? '' : 'disabled'}>Выбрать папку</button>
          </div>
          <div class="row"><button class="btn primary" id="syncnow" ${s.rootFolderId ? '' : 'disabled'}>${ico('sync')} Синхронизировать сейчас</button></div>
          <div class="muted">${state.lastSync ? 'Последняя синхронизация заметок: ' + new Date(state.lastSync).toLocaleString('ru-RU') : 'Заметки ещё не синхронизировались'}</div>
        </section>
        <section class="card">
          <h2>Книги на устройстве</h2>
          <label class="switch"><input type="checkbox" id="ac" ${s.autoCovers ? 'checked' : ''}><span>Скачивать книги заранее, чтобы показать обложки</span></label>
          <p class="muted">Скачанные книги открываются без интернета. Если место на телефоне важно — выключите.</p>
          <div class="muted" id="usage"></div>
          <div class="row"><button class="btn ghost danger-text" id="clear">Удалить скачанные книги</button></div>
          <p class="muted">Заметки, комментарии, рисунки и теги при этом сохранятся.</p>
        </section>
        <section class="card">
          <h2>Как подключить Google Диск</h2>
          <ol class="guide">
            <li>Откройте <b>console.cloud.google.com</b> и создайте проект (например, «Читалка»).</li>
            <li>В разделе <b>APIs &amp; Services → Library</b> найдите <b>Google Drive API</b> и нажмите <b>Enable</b>.</li>
            <li>В <b>OAuth consent screen</b> (экран согласия — то, что Google показывает при входе) выберите тип <b>External</b>, заполните название и почту, в <b>Test users</b> добавьте свою почту.</li>
            <li>В <b>Credentials → Create credentials → OAuth client ID</b> выберите <b>Web application</b>. В <b>Authorized JavaScript origins</b> добавьте адрес этого приложения: <code>${esc(location.origin)}</code></li>
            <li>Скопируйте <b>Client ID</b>, вставьте выше и нажмите «Войти через Google».</li>
            <li>Google предупредит, что приложение не проверено: это нормально, приложение ваше. Нажмите «Дополнительно» → «Перейти».</li>
          </ol>
          <h2 style="margin-top:18px">API-ключ для подборок</h2>
          <ol class="guide">
            <li>Там же, в <b>Credentials → Create credentials</b>, выберите <b>API key</b>.</li>
            <li>Откройте созданный ключ (<b>Edit API key</b>). В <b>Application restrictions</b> выберите <b>Websites</b> и добавьте <code>${esc(location.origin)}/*</code></li>
            <li>В <b>API restrictions</b> выберите <b>Restrict key</b> → отметьте <b>Google Drive API</b> → <b>Save</b>.</li>
            <li>Скопируйте ключ (начинается с <code>AIza</code>), вставьте в поле «API-ключ» выше и сохраните.</li>
          </ol>
          <p class="muted">По ссылке на подборку гости видят только книги из этой подборки. Остальной Диск закрыт.</p>
          <p class="muted">Приложение только читает файлы на Диске. Заметки хранятся в скрытой служебной папке приложения на вашем же Диске.</p>
        </section>
        <p class="muted center">Читалка · все данные хранятся у вас</p>
      </main>
    </div>`;
  bindCommon(app);
  $('#saveCid', app).onclick = () => { setSetting('clientId', $('#cid', app).value.trim()); setSetting('apiKey', $('#akey', app).value.trim()); toast('Ключи сохранены'); renderSettings(); };
  $('#signin', app).onclick = async () => {
    if ($('#cid', app).value.trim() !== s.clientId) setSetting('clientId', $('#cid', app).value.trim());
    try { await drive.signIn({ prompt: 'consent' }); toast('Вход выполнен'); renderSettings(); if (!state.settings.rootFolderId) pickFolder(); }
    catch (e) { toast(e.message); }
  };
  $('#signout', app)?.addEventListener('click', () => { drive.signOut(); renderSettings(); });
  $('#pick', app).onclick = pickFolder;
  $('#syncnow', app).onclick = () => syncAll({ interactive: true }).then(renderSettingsIfOpen).catch(() => {});
  $('#ac', app).onchange = (e) => setSetting('autoCovers', e.target.checked);
  $('#clear', app).onclick = async () => {
    if (!(await confirmSheet('Удалить все скачанные книги с этого устройства? Книги на Google Диске не пострадают.'))) return;
    for (const b of Object.values(state.books)) if (b.source === 'drive') await db.del('files', b.id);
    toast('Скачанные книги удалены'); showUsage();
  };
  showUsage();
}
function renderSettingsIfOpen() { if (parseHash().parts[0] === 'settings') renderSettings(); }
async function showUsage() {
  try {
    const est = await navigator.storage.estimate();
    const el = $('#usage'); if (el) el.textContent = `Занято на устройстве: ${(est.usage / 1048576).toFixed(0)} МБ`;
  } catch (e) {}
}
async function pickFolder() {
  const stack = [{ id: 'root', name: 'Мой диск' }];
  const sh = sheet(`<h3>Папка с книгами</h3><div class="crumbs"></div><div class="folder-list"><div class="spinner small"></div></div>
    <div class="sheet-actions"><button class="btn ghost" data-close>Отмена</button><button class="btn primary" id="choose">Выбрать эту папку</button></div>`, { cls: 'tall' });
  const load = async () => {
    const cur = stack[stack.length - 1];
    $('.crumbs', sh.el).innerHTML = stack.map((f, i) => `<button data-i="${i}">${esc(f.name)}</button>`).join(' › ');
    $('#choose', sh.el).disabled = cur.id === 'root';
    $('.folder-list', sh.el).innerHTML = '<div class="spinner small"></div>';
    try {
      const folders = await drive.listFolders(cur.id);
      $('.folder-list', sh.el).innerHTML = folders.length ? folders.map(f => `<button class="folder" data-id="${f.id}" data-name="${esc(f.name)}">${ico('folder')} ${esc(f.name)}</button>`).join('') : '<div class="muted">Подпапок нет</div>';
    } catch (e) { $('.folder-list', sh.el).innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
  };
  $('.crumbs', sh.el).onclick = (e) => { const b = e.target.closest('[data-i]'); if (b) { stack.length = +b.dataset.i + 1; load(); } };
  $('.folder-list', sh.el).onclick = (e) => { const b = e.target.closest('.folder'); if (b) { stack.push({ id: b.dataset.id, name: b.dataset.name }); load(); } };
  $('#choose', sh.el).onclick = async () => {
    const cur = stack[stack.length - 1];
    setSetting('rootFolderId', cur.id); setSetting('rootFolderName', cur.name);
    sh.close();
    renderSettingsIfOpen();
    syncAll({ interactive: true }).then(renderSettingsIfOpen).catch(() => {});
  };
  load();
}

// ================= Подборки (владелец) =================
const MODES = {
  read: { label: 'Только чтение', desc: 'Гость читает книги, инструменты выделения скрыты' },
  notes: { label: 'Чтение и свои заметки', desc: 'Гость может выделять, рисовать, комментировать и ставить теги. Его заметки хранятся только в его браузере' },
  mine: { label: 'Чтение и мои заметки', desc: 'Гость видит ваши выделения, рисунки и комментарии в этих книгах (без права менять)' },
};

function collectionsSection() {
  const cols = liveCollections();
  const hasDrive = Object.values(state.books).some(b => b.source === 'drive');
  if (!cols.length && !hasDrive) return '';
  return `<div class="section-head"><h2 class="section-title">Подборки</h2><button class="link-btn" data-newcol>${ico('plus')} Новая</button></div>
    ${cols.length ? `<div class="col-row">${cols.map(c => {
      const books = c.bookIds.map(id => state.books[id]).filter(Boolean);
      return `<a class="col-tile" href="#/col/${encodeURIComponent(c.id)}">
        <div class="col-covers">${books.slice(0, 4).map(b => `<div class="col-cover" data-cover="${esc(b.id)}">${fallbackCover(b.title, '', b.id)}</div>`).join('')}</div>
        <div class="cat-name">${esc(c.name)}</div>
        <div class="cat-count">${c.bookIds.length} ${plural(c.bookIds.length, 'книга', 'книги', 'книг')} · ${esc(MODES[c.mode]?.label || '')}</div>
      </a>`;
    }).join('')}</div>` : `<button class="new-col-hint" data-newcol>${ico('share')}<span>Соберите книги в подборку и поделитесь ссылкой</span></button>`}`;
}

let pendingShare = null;
function collectionLink(c) {
  return `${location.origin}${location.pathname}#/s/${c.manifestId}~${state.settings.apiKey}`;
}

function renderCollection(id) {
  const c = state.collections[id];
  if (!c || c.del) { go('#/'); return; }
  const books = c.bookIds.map(i => state.books[i]).filter(Boolean);
  app.innerHTML = `
    <div class="screen">
      ${topBar(c.name, { backBtn: true, right: `<button class="icon-btn" data-edit aria-label="Изменить">${ico('edit')}</button><button class="icon-btn" data-share aria-label="Поделиться">${ico('share')}</button>` })}
      <main class="content">
        ${c.desc ? `<p class="col-desc">${esc(c.desc)}</p>` : ''}
        <div class="col-info"><span class="chip">${esc(MODES[c.mode].label)}</span>${c.manifestId ? '' : '<span class="chip warn">Ещё не опубликована</span>'}</div>
        <div class="book-grid">${books.map(b => {
          const pct = state.progress[b.id]?.pct;
          return `<a class="book-card" href="#/read/${encodeURIComponent(b.id)}">
            <div class="cover" data-cover="${esc(b.id)}">${fallbackCover(b.title, b.author, b.id)}</div>
            ${pct != null ? `<div class="bar"><i style="width:${pct}%"></i></div>` : '<div class="bar empty"></div>'}
            <div class="bk-title">${esc(b.title)}</div><div class="bk-author">${esc(b.author || '')}</div>
          </a>`;
        }).join('')}</div>
        ${c.bookIds.length > books.length ? `<p class="muted">${c.bookIds.length - books.length} ${plural(c.bookIds.length - books.length, 'книга не найдена', 'книги не найдены', 'книг не найдено')} в библиотеке — возможно, файл удалён с Диска.</p>` : ''}
      </main>
    </div>`;
  bindCommon(app);
  $('[data-edit]', app).onclick = () => openCollectionEditor(c);
  $('[data-share]', app).onclick = () => shareCollection(c);
  fillCovers(app);
  if (pendingShare === c.id) { pendingShare = null; shareCollection(c); }
}

function openCollectionEditor(existing) {
  const c = existing ? JSON.parse(JSON.stringify(existing)) : { id: uid(), name: '', desc: '', mode: 'notes', bookIds: [], perms: {} };
  const selected = new Set(c.bookIds);
  const driveBooks = Object.values(state.books).filter(b => b.source === 'drive');
  const groupOf = (b) => b.sub ? `${b.category} / ${b.sub}` : b.category;
  const cats = [...new Set(driveBooks.map(groupOf))].sort((a, b) => a.localeCompare(b, 'ru'));
  const sh = sheet(`
    <h3>${existing ? 'Подборка' : 'Новая подборка'}</h3>
    <div class="col-editor">
      <label class="field"><span>Название</span><input id="cname" value="${esc(c.name)}" placeholder="Например: «Для студентов 2 курса»"></label>
      <label class="field"><span>Описание (необязательно)</span><textarea id="cdesc" rows="2">${esc(c.desc || '')}</textarea></label>
      <div class="lbl">Что может гость</div>
      <div class="modes">${Object.entries(MODES).map(([k, m]) => `<label class="mode"><input type="radio" name="mode" value="${k}" ${c.mode === k ? 'checked' : ''}><span><b>${m.label}</b><small>${m.desc}</small></span></label>`).join('')}</div>
      <div class="lbl">Книги <b id="cnt">${selected.size}</b></div>
      ${driveBooks.length ? `<div class="search"><span>${ico('search')}</span><input type="search" id="bq" placeholder="Найти книгу"></div>
      <div class="pick-list">${cats.map(cat => `<div class="pick-cat">${esc(cat)}</div>${driveBooks.filter(b => groupOf(b) === cat).sort((a, b) => a.title.localeCompare(b.title, 'ru')).map(b => `
        <label class="pick" data-q="${esc((b.title + ' ' + (b.author || '')).toLowerCase())}"><input type="checkbox" value="${esc(b.id)}" ${selected.has(b.id) ? 'checked' : ''}><span>${esc(b.title)}${b.author ? `<small>${esc(b.author)}</small>` : ''}</span></label>`).join('')}`).join('')}</div>`
        : '<p class="muted">В подборку можно добавить только книги с Google Диска. Сначала подключите Диск в настройках.</p>'}
      <p class="muted">Книги из подборки и сама подборка станут доступны всем, у кого есть ссылка (только просмотр). Остальные файлы на Диске останутся закрытыми.</p>
    </div>
    <div class="sheet-actions">
      ${existing ? '<button class="btn ghost danger-text" id="cdel">Удалить</button>' : '<button class="btn ghost" data-close>Отмена</button>'}
      <button class="btn primary" id="csave">${existing ? 'Сохранить' : 'Создать и получить ссылку'}</button>
    </div>`, { cls: 'tall' });
  const list = $('.pick-list', sh.el);
  if (list) {
    list.onchange = (e) => { if (e.target.type === 'checkbox') { e.target.checked ? selected.add(e.target.value) : selected.delete(e.target.value); $('#cnt', sh.el).textContent = selected.size; } };
    $('#bq', sh.el).oninput = (e) => {
      const q = e.target.value.trim().toLowerCase();
      $$('.pick', sh.el).forEach(l => { l.hidden = q && !l.dataset.q.includes(q); });
      $$('.pick-cat', sh.el).forEach(h2 => { let n = h2.nextElementSibling, any = false; while (n && n.classList.contains('pick')) { if (!n.hidden) any = true; n = n.nextElementSibling; } h2.hidden = !any; });
    };
  }
  $('#csave', sh.el).onclick = async () => {
    c.name = $('#cname', sh.el).value.trim();
    c.desc = $('#cdesc', sh.el).value.trim();
    c.mode = $('input[name=mode]:checked', sh.el).value;
    if (!c.name) { toast('Введите название подборки'); return; }
    if (!selected.size) { toast('Отметьте хотя бы одну книгу'); return; }
    const oldIds = existing ? existing.bookIds : [];
    c.bookIds = [...selected];
    const btn = $('#csave', sh.el); btn.disabled = true;
    try {
      await publishCollection(c, oldIds, (msg) => { btn.textContent = msg; });
      sh.close();
      if (!existing) pendingShare = c.id; else toast('Подборка обновлена');
      if (parseHash().parts[0] === 'col') renderCollection(c.id); else go('#/col/' + encodeURIComponent(c.id));
    } catch (e) {
      console.error(e); toast(e.message, 5000);
      btn.disabled = false; btn.textContent = existing ? 'Сохранить' : 'Создать и получить ссылку';
    }
  };
  const del = $('#cdel', sh.el);
  if (del) del.onclick = async () => {
    sh.close();
    if (!(await confirmSheet(`Удалить подборку «${existing.name}»? Ссылка перестанет работать. Книги на Диске останутся.`))) return;
    try { await deleteCollection(existing); toast('Подборка удалена'); go('#/'); } catch (e) { toast(e.message, 5000); }
  };
}

async function ensureCoverBlob(id) {
  let cover = await db.get('covers', id).catch(() => null);
  if (cover) return cover;
  const b = state.books[id];
  let blob = await db.get('files', id).catch(() => null);
  if (!blob && b?.source === 'drive') { blob = await drive.download(b.driveId, b.size); await db.set('files', id, blob); }
  if (!blob) return null;
  const info = await bookInfo(blob, b.format);
  b.coverTried = true;
  if (info.title && info.title.length > 1) b.title = info.title;
  if (info.author) b.author = info.author;
  applyMeta(b);
  if (info.cover) { await db.set('covers', id, info.cover); coverUrls.delete(id); }
  return info.cover || null;
}
const blobToDataUrl = (blob) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => res(null); r.readAsDataURL(blob); });

function ownerAnnsFor(c) {
  if (c.mode !== 'mine') return [];
  const ids = new Set(c.bookIds);
  return Object.values(state.annotations).filter(a => !a.del && ids.has(a.bookId))
    .map(({ id, bookId, type, color, anchor, text, comment, tags, points, width, created }) => ({ id, bookId, type, color, anchor, text, comment, tags, points, width, created }));
}
function hashStr(str) { let x = 0; for (let i = 0; i < str.length; i++) x = (x * 31 + str.charCodeAt(i)) | 0; return String(x); }

async function buildManifest(c, onMsg) {
  let booksPart = await db.get('kv', 'colbooks:' + c.id).catch(() => null);
  const cached = new Map((booksPart || []).map(b => [b.id, b]));
  const books = [];
  let i = 0;
  for (const id of c.bookIds) {
    i++;
    const b = state.books[id];
    if (!b) continue;
    let entry = cached.get(id);
    if (!entry || entry.modifiedTime !== b.modifiedTime) {
      onMsg && onMsg(`Готовлю книги… ${i}/${c.bookIds.length}`);
      let cover = null;
      try { const cb = await ensureCoverBlob(id); if (cb) cover = await blobToDataUrl(await resizeImage(cb, 200)); } catch (e) { console.warn(e); }
      entry = { id, title: b.title, author: b.author || '', format: b.format, size: b.size, modifiedTime: b.modifiedTime, resourceKey: await drive.resourceKeyOf(id), cover };
    } else { entry.title = b.title; entry.author = b.author || ''; }
    books.push(entry);
  }
  await db.set('kv', 'colbooks:' + c.id, books);
  const annotations = ownerAnnsFor(c);
  return { manifest: { v: 1, name: c.name, desc: c.desc || '', mode: c.mode, updated: Date.now(), books, annotations }, annHash: hashStr(JSON.stringify(annotations)) };
}

async function publishCollection(c, oldIds, onMsg) {
  if (!state.settings.apiKey) { go('#/settings'); throw new Error('Добавьте API-ключ в настройках — без него гости не смогут открыть ссылку'); }
  await ensureSignedIn(true);
  onMsg('Открываю доступ к книгам…');
  c.perms = c.perms || {};
  for (const id of c.bookIds) {
    if (!(id in c.perms)) c.perms[id] = await drive.shareAnyone(id);
  }
  const { manifest, annHash } = await buildManifest(c, onMsg);
  onMsg('Сохраняю подборку…');
  if (!c.folderId) c.folderId = await drive.ensureFolder('Читалка — подборки');
  const newId = await drive.writeJsonFile(c.manifestId, `Подборка — ${c.name}.json`, c.folderId, manifest);
  if (newId !== c.manifestId) { c.manifestId = newId; c.manifestPerm = await drive.shareAnyone(newId); }
  c.pubHash = annHash;
  // книги, убранные из подборки: закрываем доступ, если его открывала эта подборка и книга не входит в другие
  for (const id of oldIds.filter(x => !c.bookIds.includes(x))) {
    const permId = c.perms[id];
    delete c.perms[id];
    if (permId && !liveCollections().some(o => o.id !== c.id && o.bookIds.includes(id))) await drive.revokePermission(id, permId);
  }
  putCollection(c);
}

async function deleteCollection(c) {
  await ensureSignedIn(true);
  for (const [id, permId] of Object.entries(c.perms || {})) {
    if (permId && !liveCollections().some(o => o.id !== c.id && o.bookIds.includes(id))) await drive.revokePermission(id, permId);
  }
  if (c.manifestId) await drive.trashFile(c.manifestId);
  db.del('kv', 'colbooks:' + c.id).catch(() => {});
  putCollection({ id: c.id, name: c.name, bookIds: [], del: true });
}

// Режим «мои заметки»: обновляем опубликованную подборку, когда заметки меняются
let republishBusy = false;
async function republishOwnerNotes() {
  if (republishBusy || !drive.hasValidToken()) return;
  republishBusy = true;
  try {
    for (const c of liveCollections()) {
      if (c.mode !== 'mine' || !c.manifestId) continue;
      if (hashStr(JSON.stringify(ownerAnnsFor(c))) === c.pubHash) continue;
      const { manifest, annHash } = await buildManifest(c);
      await drive.writeJsonFile(c.manifestId, `Подборка — ${c.name}.json`, c.folderId, manifest);
      c.pubHash = annHash;
      putCollection(c);
    }
  } finally { republishBusy = false; }
}

function shareCollection(c) {
  if (!c.manifestId) { openCollectionEditor(c); return; }
  if (!state.settings.apiKey) { toast('Добавьте API-ключ в настройках'); go('#/settings'); return; }
  const link = collectionLink(c);
  const sh = sheet(`
    <h3>Ссылка на подборку</h3>
    <p class="sheet-text">По этой ссылке откроется только подборка «${esc(c.name)}» (${esc(MODES[c.mode].label.toLowerCase())}).</p>
    <div class="link-box">${esc(link)}</div>
    <div class="sheet-actions">
      ${navigator.share ? `<button class="btn ghost" id="nshare">${ico('share')} Отправить</button>` : ''}
      <button class="btn primary" id="copy">${ico('copy')} Копировать</button>
    </div>`);
  $('#copy', sh.el).onclick = async () => {
    try { await navigator.clipboard.writeText(link); toast('Ссылка скопирована'); sh.close(); }
    catch (e) { const r = document.createRange(); r.selectNodeContents($('.link-box', sh.el)); getSelection().removeAllRanges(); getSelection().addRange(r); toast('Выделите и скопируйте ссылку'); }
  };
  const ns = $('#nshare', sh.el);
  if (ns) ns.onclick = () => navigator.share({ title: c.name, text: `Подборка книг «${c.name}»`, url: link }).catch(() => {});
}

// ================= Подборки (гость) =================
const guestCache = new Map();
function parseToken(token) {
  const i = (token || '').indexOf('~');
  return i > 0 ? { manifestId: token.slice(0, i), key: token.slice(i + 1) } : null;
}
async function loadGuest(token) {
  if (guestCache.has(token)) return guestCache.get(token);
  const t = parseToken(token);
  if (!t) throw new Error('Ссылка повреждена');
  let manifest;
  try {
    manifest = await drive.publicJson(t.manifestId, t.key);
    db.set('kv', 'guest:' + t.manifestId, manifest).catch(() => {});
  } catch (e) {
    manifest = await db.get('kv', 'guest:' + t.manifestId).catch(() => null);
    if (!manifest) throw e;
  }
  const g = { token, ...t, manifest, ids: new Set(manifest.books.map(b => 'g:' + b.id)) };
  guestCache.set(token, g);
  return g;
}
function guestBase(token) { return '#/s/' + token; }
function guestNav(token, active, mode) {
  if (mode !== 'notes') return '';
  return `<nav class="bottomnav">
    <a href="${guestBase(token)}" class="${active === 'books' ? 'on' : ''}">${ico('book')}<span>Книги</span></a>
    <a href="${guestBase(token)}/tags" class="${active === 'tags' ? 'on' : ''}">${ico('tag')}<span>Мои теги</span></a>
  </nav>`;
}
async function routeGuest(parts) {
  const token = parts[1];
  document.documentElement.dataset.theme = state.settings.theme;
  let g;
  try {
    if (!guestCache.has(token)) app.innerHTML = `<div class="loading-screen"><div class="spinner"></div><div class="lt">Открываю подборку</div></div>`;
    g = await loadGuest(token);
  } catch (e) {
    app.innerHTML = `<div class="screen"><div class="welcome"><div class="welcome-ico">${ico('stack')}</div><h2>Подборка недоступна</h2><p>${esc(e.message)}</p></div></div>`;
    return;
  }
  if (parts[2] === 'read') return openGuestReader(g, parts[3], parseHash().params.get('a'));
  if (parts[2] === 'tags' && g.manifest.mode === 'notes') return renderGuestTags(g);
  if (parts[2] === 'tag' && g.manifest.mode === 'notes') return renderGuestTag(g, parts[3]);
  renderGuestHome(g);
}
function renderGuestHome(g) {
  const m = g.manifest;
  app.innerHTML = `
    <div class="screen guest">
      <header class="topbar"><h1>${esc(m.name)}</h1></header>
      <main class="content">
        ${m.desc ? `<p class="col-desc">${esc(m.desc)}</p>` : ''}
        <div class="col-info"><span class="chip">${esc(MODES[m.mode]?.label || '')}</span><span class="muted">${m.books.length} ${plural(m.books.length, 'книга', 'книги', 'книг')}</span></div>
        <div class="book-grid">${m.books.map(b => {
          const pct = state.progress['g:' + b.id]?.pct;
          return `<a class="book-card" href="${guestBase(g.token)}/read/${encodeURIComponent(b.id)}">
            <div class="cover">${b.cover ? `<img src="${b.cover}" alt="">` : fallbackCover(b.title, b.author, b.id)}</div>
            ${pct != null ? `<div class="bar"><i style="width:${pct}%"></i></div>` : '<div class="bar empty"></div>'}
            <div class="bk-title">${esc(b.title)}</div><div class="bk-author">${esc(b.author || '')}</div>
            <div class="bk-fmt">${esc(b.format.toUpperCase())}</div>
          </a>`;
        }).join('')}</div>
        <p class="muted center guest-foot">Подборка открыта по ссылке · Читалка</p>
      </main>
      ${guestNav(g.token, 'books', m.mode)}
    </div>`;
}
const guestFilter = (g) => (a) => g.ids.has(a.bookId);
function renderGuestTags(g) {
  const tags = allTags(guestFilter(g));
  app.innerHTML = `
    <div class="screen guest">
      <header class="topbar"><h1>Мои теги</h1></header>
      <main class="content">
        ${tags.length ? `<ul class="tag-list">${tags.map(([t, n]) => `<li><a href="${guestBase(g.token)}/tag/${encodeURIComponent(t)}"><span class="tag-name">#${esc(t)}</span><span class="tag-counts">${n}</span></a></li>`).join('')}</ul>`
          : `<div class="welcome"><div class="welcome-ico">${ico('tag')}</div><h2>Тегов пока нет</h2><p>Выделите текст в книге, нажмите на выделение и добавьте тег. Заметки сохраняются только на этом устройстве.</p></div>`}
      </main>
      ${guestNav(g.token, 'tags', 'notes')}
    </div>`;
}
function renderGuestTag(g, tag) {
  const items = itemsWithTag(tag, guestFilter(g));
  const title = (a) => g.manifest.books.find(b => 'g:' + b.id === a.bookId)?.title || 'Книга';
  app.innerHTML = `
    <div class="screen guest">
      ${topBar('#' + tag, { backBtn: true })}
      <main class="content"><div class="ann-list">${items.map(a => annCard(a, title(a))).join('') || '<div class="empty-state">Ничего нет</div>'}</div></main>
    </div>`;
  bindCommon(app, guestBase(g.token) + '/tags');
  $('.ann-list', app).onclick = (e) => {
    const card = e.target.closest('.ann-card'); if (!card) return;
    const a = state.annotations[card.dataset.id];
    go(`${guestBase(g.token)}/read/${encodeURIComponent(a.bookId.slice(2))}?a=${a.id}`);
  };
}
async function openGuestReader(g, fileId, annId) {
  const b = g.manifest.books.find(x => x.id === fileId);
  if (!b) { go(guestBase(g.token)); return; }
  const meta = { id: 'g:' + b.id, title: b.title, author: b.author, format: b.format, size: b.size, source: 'guest' };
  const mode = g.manifest.mode === 'notes' ? 'full' : g.manifest.mode === 'mine' ? 'owner' : 'read';
  const ownerAnns = mode === 'owner' ? (g.manifest.annotations || []).filter(a => a.bookId === b.id) : null;
  await openReaderWith({
    meta, annId, mode, ownerAnns,
    onBack: () => back(guestBase(g.token)),
    getBlob: (progress) => drive.publicDownload(b.id, g.key, b.resourceKey, b.size, progress),
  });
}

// ================= Полки =================
function shelfCount(id) {
  return booksOnShelf(id).filter(bid => state.books[bid]).length;
}
function shelvesGridHtml(list, { addLabel = 'Полка', parent = null } = {}) {
  return `<div class="cat-grid">
    ${list.map(sh => `<a class="cat-tile" href="#/shelf/${encodeURIComponent(sh.id)}">
      <div class="cat-name">${esc(sh.name)}</div>
      <div class="cat-count">${shelfCount(sh.id)}</div>
    </a>`).join('')}
    <button class="cat-tile add" data-newshelf="${esc(parent || '')}">${ico('plus')}<span>${esc(addLabel)}</span></button>
  </div>`;
}
function bindShelfButtons(root, after) {
  $$('[data-newshelf]', root).forEach(b => b.onclick = () => openShelfNameSheet(null, b.dataset.newshelf || null, after));
}
function openShelfNameSheet(shelf, parent, after) {
  const sh = sheet(`
    <h3>${shelf ? 'Переименовать полку' : parent ? 'Новая подполка' : 'Новая полка'}</h3>
    <label class="field"><span>Название</span><input id="shname" value="${esc(shelf?.name || '')}" placeholder="Например: «Нейробиология»"></label>
    <div class="sheet-actions"><button class="btn ghost" data-close>Отмена</button><button class="btn primary" id="shok">${shelf ? 'Сохранить' : 'Создать'}</button></div>`);
  const input = $('#shname', sh.el);
  setTimeout(() => input.focus(), 250);
  const ok = () => {
    const nm = input.value.trim();
    if (!nm) { toast('Введите название'); return; }
    if (shelf) renameShelf(shelf.id, nm); else addShelf(nm, parent);
    sh.close();
    after && after();
  };
  $('#shok', sh.el).onclick = ok;
  input.onkeydown = (e) => { if (e.key === 'Enter') ok(); };
}

function renderShelf(id) {
  const shelf = state.shelves[id];
  if (!shelf || shelf.del) { go('#/'); return; }
  const parent = shelf.parent && state.shelves[shelf.parent];
  const subs = liveShelves(id);
  const books = booksOnShelf(id).map(bid => state.books[bid]).filter(Boolean)
    .sort((a, b) => a.title.localeCompare(b.title, 'ru', { numeric: true }));
  app.innerHTML = `
    <div class="screen">
      ${topBar(shelf.name, { backBtn: true, right: `<button class="icon-btn" data-shmenu aria-label="Настройки полки">${ico('edit')}</button>` })}
      <main class="content">
        ${parent ? `<div class="crumb"><a href="#/shelf/${encodeURIComponent(parent.id)}">${esc(parent.name)}</a> › ${esc(shelf.name)}</div>` : ''}
        ${!shelf.parent ? `<h2 class="section-title">Подполки</h2>${shelvesGridHtml(subs, { addLabel: 'Подполка', parent: id })}` : ''}
        <h2 class="section-title">Книги</h2>
        ${books.length ? `<div class="book-grid">${books.map(bookCardHtml).join('')}</div>`
          : `<div class="empty-state">На этой полке пока нет книг. Откройте любую категорию и нажмите «⋯» на обложке, чтобы положить книгу на полку.</div>`}
      </main>
    </div>`;
  bindCommon(app, parent ? '#/shelf/' + encodeURIComponent(parent.id) : '#/');
  bindShelfButtons(app, () => renderShelf(id));
  bindBookCards(app, () => renderShelf(id));
  $('[data-shmenu]', app).onclick = () => {
    const sh = sheet(`<h3>${esc(shelf.name)}</h3>
      <div class="menu-list">
        <button class="menu-item" id="ren">${ico('edit')} Переименовать</button>
        <button class="menu-item danger-text" id="del">Удалить полку</button>
      </div>`);
    $('#ren', sh.el).onclick = () => { sh.close(); openShelfNameSheet(shelf, null, () => renderShelf(id)); };
    $('#del', sh.el).onclick = async () => {
      sh.close();
      if (!(await confirmSheet(`Удалить полку «${shelf.name}»${subs.length ? ' вместе с подполками' : ''}? Книги останутся в библиотеке и на Диске.`))) return;
      deleteShelf(id); toast('Полка удалена'); go(parent ? '#/shelf/' + encodeURIComponent(parent.id) : '#/');
    };
  };
  fillCovers(app);
  queueCovers(books.map(b => b.id));
}

// Меню книги: полки (несколько сразу), перенос в папку Диска, удаление файла с устройства
function bindBookCards(root, rerender) {
  $$('[data-menu]', root).forEach(b => b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openBookMenu(state.books[b.dataset.menu], rerender); });
  $$('[data-fav]', root).forEach(c => c.onchange = () => { setFavorite(c.dataset.fav, c.checked); toast(c.checked ? 'Добавлено в «Читаю»' : 'Убрано из «Читаю»'); });
}
function openBookMenu(b, rerender) {
  if (!b) return;
  const selected = new Set(shelvesOf(b.id));
  const row = (shf, isSub) => `<label class="pick ${isSub ? 'is-sub' : ''}"><input type="checkbox" value="${esc(shf.id)}" ${selected.has(shf.id) ? 'checked' : ''}><span>${esc(shf.name)}</span></label>`;
  const sh = sheet(`
    <h3>${esc(b.title)}</h3>
    ${b.author ? `<p class="menu-author">${esc(b.author)}</p>` : ''}
    <button class="link-btn" id="edmeta">${ico('edit')} Изменить название и автора</button>
    <div class="lbl">Полки <b id="shcnt">${selected.size}</b></div>
    <div class="search"><span>${ico('search')}</span><input type="search" id="shq" placeholder="Найти полку"></div>
    <div class="pick-list shelf-pick">${liveShelves().map(p => row(p, false) + liveShelves(p.id).map(c => row(c, true)).join('')).join('')}</div>
    <button class="link-btn" id="shnew">${ico('plus')} Новая полка</button>
    <div class="sheet-actions">
      ${b.source === 'drive' ? `<button class="btn ghost" id="mv">${ico('folder')} В другую папку Диска</button>` : ''}
      ${b.source === 'local' ? `<button class="btn ghost danger-text" id="rm">Удалить с устройства</button>` : ''}
      <button class="btn primary" id="shsave">Готово</button>
    </div>`, { cls: 'tall' });
  const list = $('.shelf-pick', sh.el);
  list.onchange = (e) => { if (e.target.type === 'checkbox') { e.target.checked ? selected.add(e.target.value) : selected.delete(e.target.value); $('#shcnt', sh.el).textContent = selected.size; } };
  $('#shq', sh.el).oninput = (e) => { const q = e.target.value.trim().toLowerCase(); $$('.pick', list).forEach(l => { l.hidden = q && !l.textContent.toLowerCase().includes(q); }); };
  const saveSel = () => { setBookShelves(b.id, [...selected]); };
  $('#shsave', sh.el).onclick = () => { saveSel(); sh.close(); toast(selected.size ? `Полок: ${selected.size}` : 'Книга убрана со всех полок'); rerender && rerender(); };
  $('#edmeta', sh.el).onclick = () => { saveSel(); sh.close(); openMetaEditor(b, rerender); };
  $('#shnew', sh.el).onclick = () => { saveSel(); sh.close(); openShelfNameSheet(null, null, () => openBookMenu(b, rerender)); };
  const mv = $('#mv', sh.el);
  if (mv) mv.onclick = () => { saveSel(); sh.close(); openMoveSheet(b, rerender); };
  const rm = $('#rm', sh.el);
  if (rm) rm.onclick = async () => {
    saveSel(); sh.close();
    if (!(await confirmSheet(`Удалить «${b.title}» с устройства? Заметки и комментарии сохранятся.`))) return;
    delete state.books[b.id];
    await db.del('files', b.id); await db.del('covers', b.id);
    save('books', { sync: false }); rerender && rerender();
  };
}

function openMetaEditor(b, rerender) {
  const sh = sheet(`
    <h3>Название и автор</h3>
    <label class="field"><span>Название</span><textarea id="mtitle" rows="2">${esc(b.title)}</textarea></label>
    <label class="field"><span>Автор</span><input id="mauthor" value="${esc(b.author || '')}" placeholder="Имя автора"></label>
    <p class="muted">Файл на Диске не переименовывается — меняется только то, как книга подписана в читалке.</p>
    <div class="sheet-actions"><button class="btn ghost" data-close>Отмена</button><button class="btn primary" id="msave">Сохранить</button></div>`);
  $('#msave', sh.el).onclick = () => {
    const t = $('#mtitle', sh.el).value.trim().replace(/\s+/g, ' ');
    if (!t) { toast('Название не может быть пустым'); return; }
    setBookMeta(b.id, t, $('#mauthor', sh.el).value.trim());
    sh.close(); toast('Сохранено'); rerender && rerender();
  };
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

start();
