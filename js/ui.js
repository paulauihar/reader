// Общие элементы интерфейса: всплывающие листы, уведомления, редактор тегов.
import { allTags } from './store.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }

export const HL_COLORS = {
  yellow: { name: 'Жёлтый', css: 'var(--hl-yellow)' },
  green: { name: 'Зелёный', css: 'var(--hl-green)' },
  blue: { name: 'Голубой', css: 'var(--hl-blue)' },
  pink: { name: 'Розовый', css: 'var(--hl-pink)' },
  orange: { name: 'Оранжевый', css: 'var(--hl-orange)' },
};
export const PEN_COLORS = ['#e5484d', '#2f6fde', '#1f9d55', '#222222', '#f5a524'];

let toastTimer;
export function toast(msg, ms = 2600) {
  let t = $('#toast');
  if (!t) { t = h('<div id="toast" role="status"></div>'); document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// Нижний лист (на планшете — по центру)
export function sheet(contentHtml, { onClose, cls = '' } = {}) {
  const wrap = h(`<div class="sheet-wrap ${cls}"><div class="sheet-backdrop"></div><div class="sheet" role="dialog"><div class="sheet-grip"></div>${contentHtml}</div></div>`);
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    wrap.classList.remove('open');
    setTimeout(() => wrap.remove(), 220);
    window.removeEventListener('popstate', onPop);
    onClose && onClose();
  };
  const onPop = () => close();
  wrap.querySelector('.sheet-backdrop').addEventListener('click', close);
  wrap.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  return { el: wrap.querySelector('.sheet'), close };
}

export function confirmSheet(text, okLabel = 'Удалить') {
  return new Promise(resolve => {
    let result = false;
    const s = sheet(`<p class="sheet-text">${esc(text)}</p><div class="sheet-actions"><button class="btn ghost" data-close>Отмена</button><button class="btn danger" id="ok">${esc(okLabel)}</button></div>`, { onClose: () => resolve(result) });
    s.el.querySelector('#ok').onclick = () => { result = true; s.close(); };
  });
}

// Редактор тегов: чипы + поле ввода с подсказками
export function tagEditor(container, initial = [], onChange) {
  let tags = [...initial];
  container.classList.add('tag-editor');
  container.innerHTML = `<div class="chips"></div><div class="tag-input-row"><input type="text" placeholder="Добавить тег…" enterkeyhint="done" autocapitalize="none"><button class="btn small" type="button">＋</button></div><div class="tag-suggest"></div>`;
  const chips = $('.chips', container), input = $('input', container), sug = $('.tag-suggest', container), addBtn = $('button', container);
  const render = () => {
    chips.innerHTML = tags.map(t => `<span class="chip">#${esc(t)}<button type="button" data-t="${esc(t)}" aria-label="Убрать тег">×</button></span>`).join('');
    const q = input.value.trim().toLowerCase().replace(/^#/, '');
    const list = allTags().map(([t]) => t).filter(t => !tags.includes(t) && (!q || t.toLowerCase().includes(q))).slice(0, 12);
    sug.innerHTML = list.map(t => `<button type="button" class="chip ghost" data-s="${esc(t)}">#${esc(t)}</button>`).join('');
  };
  const add = (raw) => {
    for (let t of raw.split(',')) {
      t = t.trim().replace(/^#+/, '').replace(/\s+/g, ' ');
      if (t && !tags.includes(t)) tags.push(t);
    }
    input.value = '';
    render(); onChange && onChange(tags);
  };
  chips.addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (b) { tags = tags.filter(x => x !== b.dataset.t); render(); onChange && onChange(tags); } });
  sug.addEventListener('click', e => { const b = e.target.closest('[data-s]'); if (b) add(b.dataset.s); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); if (input.value.trim()) add(input.value); } });
  input.addEventListener('input', render);
  addBtn.addEventListener('click', () => { if (input.value.trim()) add(input.value); else input.focus(); });
  render();
  return { get: () => { if (input.value.trim()) add(input.value); return tags; } };
}

export function fmtDate(t) {
  if (!t) return '';
  const d = new Date(t);
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
}
export function excerpt(s, n = 220) { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// «Обложка-заглушка» из названия
export function fallbackCover(title, author, seed = '') {
  const palettes = [['#5b4636', '#e8d9c0'], ['#2f4858', '#d8e3e7'], ['#5a3d5c', '#eadcea'], ['#33563b', '#dce9d8'], ['#6b2d2d', '#f0dada'], ['#3b3f6b', '#dddff2'], ['#6b5a2d', '#f2ead2']];
  let hsh = 0; for (const ch of (seed || title)) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
  const [bg, fg] = palettes[hsh % palettes.length];
  return `<div class="fallback-cover" style="background:${bg};color:${fg}"><div class="fc-title">${esc(excerpt(title, 70))}</div>${author ? `<div class="fc-author">${esc(excerpt(author, 40))}</div>` : ''}</div>`;
}
