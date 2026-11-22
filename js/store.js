// Состояние приложения: библиотека, прогресс чтения, заметки/комментарии/рисунки, теги, настройки.
import { db } from './db.js';

const listeners = new Set();
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const now = () => Date.now();

export const state = {
  // Библиотека (локальная, пересобирается из Google Диска)
  books: {},          // id -> {id, title, author, format, category, sub, parentId, driveId, modifiedTime, size, source}
  favorites: {},      // bookId -> {on, t} — «Читаю сейчас»
  shelves: {},        // id -> {id, name, parent, order, t, del} — полки (книга может быть на нескольких)
  shelfBooks: {},     // bookId -> {ids: [shelfId…], t}
  folders: {},        // id папки -> {id, name, cat, sub} — категории и подкатегории на Диске
  // Синхронизируемые данные
  progress: {},       // bookId -> {pos, pct, t}
  annotations: {},    // id -> {id, bookId, type:'hl'|'cm'|'ink', color, anchor, text, comment, tags, t, del}
  bookTitles: {},     // bookId -> title (чтобы теги показывали название, даже если книги нет на устройстве)
  collections: {},    // id -> {id, name, desc, mode, bookIds, manifestId, perms, t, del, pubHash}
  lastOpened: null,   // bookId
  // Локальные настройки
  settings: {
    theme: 'light',   // light | sepia | gray | dark
    brightness: 100,  // 30..100
    fontSize: 19,     // px
    pdfZoom: 1,
    hlColor: 'yellow',
    penColor: '#e5484d',
    penWidth: 3,
    clientId: '',
    apiKey: '',
    rootFolderId: '',
    rootFolderName: '',
    autoCovers: true,
  },
  dirty: false,       // есть несинхронизированные изменения
  lastSync: 0,
};

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(what) { for (const fn of listeners) try { fn(what); } catch (e) { console.error(e); } }

let saveTimer = null;
export function save(what = 'data', { sync = true } = {}) {
  if (sync) state.dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 300);
  emit(what);
}

export async function persist() {
  clearTimeout(saveTimer);
  await db.set('kv', 'state', {
    books: state.books, progress: state.progress, annotations: state.annotations,
    bookTitles: state.bookTitles, lastOpened: state.lastOpened, settings: state.settings, collections: state.collections, folders: state.folders, favorites: state.favorites, shelves: state.shelves, shelfBooks: state.shelfBooks,
    dirty: state.dirty, lastSync: state.lastSync,
  });
}

export async function load() {
  const saved = await db.get('kv', 'state');
  if (saved) {
    Object.assign(state, saved);
    state.collections = saved.collections || {};
    state.folders = saved.folders || {};
    state.favorites = saved.favorites || {};
    state.shelves = saved.shelves || {};
    state.shelfBooks = saved.shelfBooks || {};
    state.settings = Object.assign({}, defaultsSettings(), saved.settings || {});
  }
}
function defaultsSettings() {
  return { theme: 'light', brightness: 100, fontSize: 19, pdfZoom: 1, hlColor: 'yellow', penColor: '#e5484d', penWidth: 3, clientId: '', apiKey: '', rootFolderId: '', rootFolderName: '', autoCovers: true };
}

export function setSetting(key, val) {
  state.settings[key] = val;
  save('settings', { sync: false });
}

// ---------- Аннотации ----------
export function addAnnotation(a) {
  const ann = Object.assign({ id: uid(), tags: [], t: now(), created: now() }, a);
  state.annotations[ann.id] = ann;
  if (state.books[ann.bookId]) state.bookTitles[ann.bookId] = state.books[ann.bookId].title;
  save('annotations');
  return ann;
}
export function updateAnnotation(id, patch) {
  const a = state.annotations[id];
  if (!a) return;
  Object.assign(a, patch, { t: now() });
  save('annotations');
}
export function deleteAnnotation(id) {
  const a = state.annotations[id];
  if (!a) return;
  // «надгробие» — чтобы удаление синхронизировалось на другие устройства
  state.annotations[id] = { id, bookId: a.bookId, type: a.type, del: true, t: now() };
  save('annotations');
}
export function annotationsOf(bookId, type) {
  return Object.values(state.annotations)
    .filter(a => !a.del && a.bookId === bookId && (!type || a.type === type));
}
// Гостевые книги (открытые по чужой ссылке) имеют id вида «g:…» и в общих тегах владельца не показываются
const ownFilter = a => !String(a.bookId).startsWith('g:');
export function allTags(filter = ownFilter) {
  const map = new Map();
  for (const a of Object.values(state.annotations)) {
    if (a.del || !a.tags || !filter(a)) continue;
    for (const t of a.tags) map.set(t, (map.get(t) || 0) + 1);
  }
  return [...map.entries()].sort((x, y) => x[0].localeCompare(y[0], 'ru'));
}
export function itemsWithTag(tag, filter = ownFilter) {
  return Object.values(state.annotations)
    .filter(a => !a.del && a.tags && a.tags.includes(tag) && filter(a))
    .sort((x, y) => (y.created || y.t) - (x.created || x.t));
}

// ---------- Подборки ----------
export function liveCollections() {
  return Object.values(state.collections || {}).filter(c => !c.del).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}
export function putCollection(c) {
  c.t = now();
  state.collections[c.id] = c;
  save('collections');
}

// ---------- Прогресс ----------
export function setProgress(bookId, pos, pct) {
  state.progress[bookId] = { pos, pct, t: now() };
  state.lastOpened = bookId;
  save('progress');
}

// ---------- Синхронизация: слияние с данными с Диска ----------
export function exportSyncData() {
  return {
    version: 1,
    progress: state.progress,
    annotations: state.annotations,
    bookTitles: state.bookTitles,
    lastOpened: state.lastOpened,
    collections: state.collections,
    favorites: state.favorites,
    shelves: state.shelves,
    shelfBooks: state.shelfBooks,
  };
}
export function mergeSyncData(remote) {
  if (!remote || typeof remote !== 'object') return false;
  let changed = false;
  for (const [k, v] of Object.entries(remote.progress || {})) {
    const l = state.progress[k];
    if (!l || (v.t || 0) > (l.t || 0)) { state.progress[k] = v; changed = true; }
  }
  for (const [k, v] of Object.entries(remote.annotations || {})) {
    const l = state.annotations[k];
    if (!l || (v.t || 0) > (l.t || 0)) { state.annotations[k] = v; changed = true; }
  }
  for (const [k, v] of Object.entries(remote.bookTitles || {})) {
    if (!state.bookTitles[k]) { state.bookTitles[k] = v; changed = true; }
  }
  for (const key of ['shelves', 'shelfBooks']) {
    for (const [k, v] of Object.entries(remote[key] || {})) {
      const l = state[key][k];
      if (!l || (v.t || 0) > (l.t || 0)) { state[key][k] = v; changed = true; }
    }
  }
  for (const [k, v] of Object.entries(remote.favorites || {})) {
    const l = state.favorites[k];
    if (!l || (v.t || 0) > (l.t || 0)) { state.favorites[k] = v; changed = true; }
  }
  for (const [k, v] of Object.entries(remote.collections || {})) {
    const l = state.collections[k];
    if (!l || (v.t || 0) > (l.t || 0)) { state.collections[k] = v; changed = true; }
  }
  if (remote.lastOpened && !state.lastOpened) state.lastOpened = remote.lastOpened;
  if (changed) emit('data');
  return changed;
}

export function isFavorite(id) { return !!state.favorites[id]?.on; }
export function setFavorite(id, on) { state.favorites[id] = { on, t: now() }; save('favorites'); }

// ---------- Полки ----------
const DEFAULT_SHELVES = ['Health', 'Eco', 'Critical Thinking', 'Tweens and Teens', 'Relationships', 'CPT', 'English', 'Economy',
  'Psychology', 'Emotions', 'Art and Aesthetic', 'Philosophy', 'Education', 'Non-fiction', 'Sociology', 'Fiction', 'Soft skills',
  'Creative Thinking', 'Statistics', 'Aggression', 'Future', 'Книги для женщин', 'Studying', 'Psychotherapy', 'History', 'Polskie',
  'AI', 'Psychometrics', 'EdTech', 'Management', 'Smartreading and IviGreen', 'Помощь и подарки', 'Прочитанные книги'];
// Одинаковые id на всех устройствах — чтобы стартовые полки не задвоились при синхронизации
const shelfIdFor = (name) => { let x = 0; for (const ch of name) x = (x * 31 + ch.charCodeAt(0)) >>> 0; return 'sh-' + x.toString(36); };
export function seedShelves() {
  if (state.settings.shelvesSeeded) return;
  if (!Object.keys(state.shelves).length) {
    DEFAULT_SHELVES.forEach((name, i) => { const id = shelfIdFor(name); state.shelves[id] = { id, name, parent: null, order: i, t: 1 }; });
  }
  state.settings.shelvesSeeded = true;
  save('shelves', { sync: false });
}
export function liveShelves(parent = null) {
  return Object.values(state.shelves).filter(x => !x.del && (x.parent || null) === parent)
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.name.localeCompare(b.name, 'ru'));
}
export function addShelf(name, parent = null) {
  const id = 'sh-' + uid();
  const order = Math.max(-1, ...Object.values(state.shelves).map(x => x.order ?? 0)) + 1;
  state.shelves[id] = { id, name, parent, order, t: now() };
  save('shelves');
  return state.shelves[id];
}
export function renameShelf(id, name) { Object.assign(state.shelves[id], { name, t: now() }); save('shelves'); }
export function deleteShelf(id) {
  for (const child of liveShelves(id)) deleteShelf(child.id);
  Object.assign(state.shelves[id], { del: true, t: now() });
  save('shelves');
}
export function shelvesOf(bookId) {
  return (state.shelfBooks[bookId]?.ids || []).filter(id => state.shelves[id] && !state.shelves[id].del);
}
export function setBookShelves(bookId, ids) { state.shelfBooks[bookId] = { ids: [...new Set(ids)], t: now() }; save('shelves'); }
export function booksOnShelf(shelfId) {
  return Object.keys(state.shelfBooks).filter(bid => shelvesOf(bid).includes(shelfId));
}
