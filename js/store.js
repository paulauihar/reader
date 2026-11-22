// Состояние приложения: библиотека, прогресс чтения, заметки/комментарии/рисунки, теги, настройки.
import { db } from './db.js';

const listeners = new Set();
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const now = () => Date.now();

export const state = {
  // Библиотека (локальная, пересобирается из Google Диска)
  books: {},          // id -> {id, title, author, format, category, sub, parentId, driveId, modifiedTime, size, source}
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
    bookTitles: state.bookTitles, lastOpened: state.lastOpened, settings: state.settings, collections: state.collections, folders: state.folders,
    dirty: state.dirty, lastSync: state.lastSync,
  });
}

export async function load() {
  const saved = await db.get('kv', 'state');
  if (saved) {
    Object.assign(state, saved);
    state.collections = saved.collections || {};
    state.folders = saved.folders || {};
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
  for (const [k, v] of Object.entries(remote.collections || {})) {
    const l = state.collections[k];
    if (!l || (v.t || 0) > (l.t || 0)) { state.collections[k] = v; changed = true; }
  }
  if (remote.lastOpened && !state.lastOpened) state.lastOpened = remote.lastOpened;
  if (changed) emit('data');
  return changed;
}
