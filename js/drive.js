// Работа с Google Диском: вход, список книг, скачивание, хранение заметок в скрытой папке приложения.
import { state } from './store.js';

// Полный доступ к Диску нужен, чтобы открывать книги по ссылке для подборок. Сами книги приложение не меняет.
const SCOPES = 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.appdata';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const SYNC_FILE = 'reader-data.json';

export const SUPPORTED = ['epub', 'pdf', 'fb2', 'fb2.zip', 'txt', 'mobi', 'azw3', 'azw', 'prc', 'docx', 'cbz', 'djvu'];
export function formatOf(name) {
  const n = name.toLowerCase();
  if (n.endsWith('.fb2.zip')) return 'fb2.zip';
  const ext = n.split('.').pop();
  return SUPPORTED.includes(ext) ? ext : null;
}
export function cleanTitle(name) {
  return name.replace(/\.fb2\.zip$/i, '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_]+/g, ' ').trim();
}

export class AuthError extends Error {}

let tokenClient = null;
let token = null;
try { token = JSON.parse(localStorage.getItem('gtoken') || 'null'); } catch (e) {}

export function isConfigured() { return !!state.settings.clientId; }
export function hasValidToken() { return token && token.exp > Date.now() + 60000; }
export function wasConnected() { try { return localStorage.getItem('gconnected') === '1'; } catch (e) { return false; } }

function gisReady() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    let n = 0;
    const iv = setInterval(() => {
      if (window.google?.accounts?.oauth2) { clearInterval(iv); resolve(); }
      else if (++n > 100) { clearInterval(iv); reject(new Error('Не удалось загрузить вход Google. Проверьте интернет.')); }
    }, 100);
  });
}

// Получить токен доступа. Вызывать из обработчика нажатия (иначе браузер заблокирует окно входа).
export async function signIn({ prompt = '' } = {}) {
  if (!isConfigured()) throw new Error('Укажите Client ID в настройках.');
  await gisReady();
  return new Promise((resolve, reject) => {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: state.settings.clientId,
      scope: SCOPES,
      callback: (resp) => {
        if (resp.error) return reject(new Error(resp.error_description || resp.error));
        if (!google.accounts.oauth2.hasGrantedAllScopes(resp, ...SCOPES.split(' '))) {
          return reject(new Error('Google не выдал все разрешения. Войдите снова и отметьте все галочки.'));
        }
        token = { access: resp.access_token, exp: Date.now() + (resp.expires_in || 3600) * 1000 };
        try { localStorage.setItem('gtoken', JSON.stringify(token)); localStorage.setItem('gconnected', '1'); } catch (e) {}
        resolve(token);
      },
      error_callback: (err) => reject(new Error(err?.message || 'Вход отменён')),
    });
    tokenClient.requestAccessToken({ prompt: wasConnected() ? prompt : 'consent' });
  });
}

export function signOut() {
  if (token && window.google?.accounts?.oauth2) try { google.accounts.oauth2.revoke(token.access); } catch (e) {}
  token = null;
  try { localStorage.removeItem('gtoken'); localStorage.removeItem('gconnected'); } catch (e) {}
}

async function ensureToken() {
  if (hasValidToken()) return token.access;
  throw new AuthError('Нужно войти в Google снова');
}

async function api(url, opts = {}) {
  const access = await ensureToken();
  const res = await fetch(url, Object.assign({}, opts, {
    headers: Object.assign({ Authorization: 'Bearer ' + access }, opts.headers || {}),
  }));
  if (res.status === 401) { token = null; try { localStorage.removeItem('gtoken'); } catch (e) {} throw new AuthError('Сессия Google истекла'); }
  if (!res.ok) throw new Error('Google Диск: ошибка ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return res;
}

async function listAll(q, fields = 'id,name,mimeType,size,modifiedTime,parents', spaces = 'drive') {
  const out = [];
  let pageToken = '';
  do {
    const p = new URLSearchParams({ q, fields: `nextPageToken,files(${fields})`, pageSize: '1000', spaces, supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
    if (pageToken) p.set('pageToken', pageToken);
    const data = await (await api(`${API}/files?${p}`)).json();
    out.push(...data.files);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

// Папки для выбора корневой папки библиотеки
export async function listFolders(parentId = 'root') {
  const files = await listAll(`'${parentId}' in parents and mimeType='${FOLDER}' and trashed=false`, 'id,name');
  return files.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

// Обойти папку библиотеки. Подпапки первого уровня = категории.
// Обойти папку библиотеки. Подпапки первого уровня = категории, второго = подкатегории.
export async function scanLibrary(rootId, onProgress) {
  const books = [];
  const folders = {};   // id -> {id, name, cat, sub}
  const queue = [{ id: rootId, category: null, sub: null, depth: 0 }];
  let scanned = 0;
  while (queue.length) {
    const { id, category, sub, depth } = queue.shift();
    const items = await listAll(`'${id}' in parents and trashed=false`);
    scanned++;
    onProgress && onProgress(scanned);
    for (const f of items) {
      if (f.mimeType === FOLDER) {
        if (depth === 0) folders[f.id] = { id: f.id, name: f.name, cat: f.name, sub: null };
        else if (depth === 1) folders[f.id] = { id: f.id, name: f.name, cat: category, sub: f.name };
        queue.push({ id: f.id, category: category || f.name, sub: depth === 1 ? f.name : sub, depth: depth + 1 });
      } else {
        const format = formatOf(f.name);
        if (!format) continue;
        books.push({
          id: f.id, driveId: f.id, source: 'drive', format,
          fileName: f.name, title: cleanTitle(f.name), author: '',
          category: category || 'Без категории', sub: sub || null, parentId: id,
          size: +f.size || 0, modifiedTime: f.modifiedTime,
        });
      }
    }
  }
  return { books, folders };
}
export async function createFolder(name, parentId) {
  const res = await api(`${API}/files?fields=id,name&supportsAllDrives=true`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: FOLDER, parents: [parentId] }) });
  return await res.json();
}
// Переместить файл в другую папку на Диске
export async function moveFile(fileId, toParent, fromParent) {
  const p = new URLSearchParams({ addParents: toParent, supportsAllDrives: 'true', fields: 'id,parents' });
  if (fromParent && fromParent !== toParent) p.set('removeParents', fromParent);
  await api(`${API}/files/${fileId}?${p}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
}

export async function download(fileId, size, onProgress) {
  const res = await api(`${API}/files/${fileId}?alt=media&supportsAllDrives=true`);
  if (!res.body || !onProgress) return await res.blob();
  const total = size || +res.headers.get('content-length') || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total) onProgress(Math.min(1, got / total));
  }
  return new Blob(chunks);
}

// ---------- Синхронизация заметок через скрытую папку приложения на Диске ----------
let syncFileId = null;
async function findSyncFile() {
  if (syncFileId) return syncFileId;
  const files = await listAll(`name='${SYNC_FILE}' and 'appDataFolder' in parents and trashed=false`, 'id,name,modifiedTime', 'appDataFolder');
  syncFileId = files[0]?.id || null;
  return syncFileId;
}
export async function readSyncData() {
  const id = await findSyncFile();
  if (!id) return null;
  const res = await api(`${API}/files/${id}?alt=media`);
  try { return await res.json(); } catch (e) { return null; }
}
export async function writeSyncData(data) {
  const body = JSON.stringify(data);
  const id = await findSyncFile();
  if (id) {
    await api(`${UPLOAD}/files/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
  } else {
    const boundary = 'b' + Math.random().toString(36).slice(2);
    const meta = { name: SYNC_FILE, parents: ['appDataFolder'], mimeType: 'application/json' };
    const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
    const res = await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart });
    syncFileId = (await res.json()).id;
  }
}

// ---------- Подборки: публичный доступ по ссылке ----------
export async function ensureFolder(name) {
  const q = `name='${name.replace(/'/g, "\\'")}' and mimeType='${FOLDER}' and 'root' in parents and trashed=false`;
  const found = await listAll(q, 'id,name');
  if (found[0]) return found[0].id;
  const res = await api(`${API}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: FOLDER, parents: ['root'] }) });
  return (await res.json()).id;
}
export async function writeJsonFile(fileId, name, parentId, data) {
  const body = JSON.stringify(data);
  if (fileId) {
    try {
      await api(`${UPLOAD}/files/${fileId}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
      return fileId;
    } catch (e) { if (!/ 404/.test(e.message)) throw e; }
  }
  const boundary = 'b' + Math.random().toString(36).slice(2);
  const meta = { name, parents: [parentId], mimeType: 'application/json' };
  const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  const res = await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart });
  return (await res.json()).id;
}
// Открыть файл «всем, у кого есть ссылка» (только просмотр). Возвращает id разрешения или null, если доступ уже был.
export async function shareAnyone(fileId) {
  const perms = await (await api(`${API}/files/${fileId}/permissions?fields=permissions(id,type,role)&supportsAllDrives=true`)).json();
  if ((perms.permissions || []).some(p => p.type === 'anyone')) return null;
  const res = await api(`${API}/files/${fileId}/permissions?fields=id&supportsAllDrives=true`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'anyone', role: 'reader', allowFileDiscovery: false }),
  });
  return (await res.json()).id;
}
export async function revokePermission(fileId, permId) {
  try { await api(`${API}/files/${fileId}/permissions/${permId}?supportsAllDrives=true`, { method: 'DELETE' }); } catch (e) { console.warn(e); }
}
export async function resourceKeyOf(fileId) {
  const r = await (await api(`${API}/files/${fileId}?fields=resourceKey&supportsAllDrives=true`)).json();
  return r.resourceKey || '';
}
export async function trashFile(fileId) {
  try { await api(`${API}/files/${fileId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) }); } catch (e) { console.warn(e); }
}

// Гость: чтение открытых по ссылке файлов с помощью API-ключа, без входа
async function publicFetch(fileId, key, resourceKey) {
  const headers = resourceKey ? { 'X-Goog-Drive-Resource-Keys': `${fileId}/${resourceKey}` } : {};
  const res = await fetch(`${API}/files/${fileId}?alt=media&supportsAllDrives=true&key=${encodeURIComponent(key)}`, { headers });
  if (res.status === 403 || res.status === 404) throw new Error('Доступ к подборке закрыт или ссылка устарела');
  if (!res.ok) throw new Error('Google Диск: ошибка ' + res.status);
  return res;
}
export async function publicJson(fileId, key) {
  return await (await publicFetch(fileId, key)).json();
}
export async function publicDownload(fileId, key, resourceKey, size, onProgress) {
  const res = await publicFetch(fileId, key, resourceKey);
  if (!res.body || !onProgress) return await res.blob();
  const total = size || +res.headers.get('content-length') || 0;
  const reader = res.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    if (total) onProgress(Math.min(1, got / total));
  }
  return new Blob(chunks);
}
