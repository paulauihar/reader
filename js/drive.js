// Работа с Google Диском: вход, список книг, скачивание, хранение заметок в скрытой папке приложения.
import { state } from './store.js';

const SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.appdata';
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
export async function scanLibrary(rootId, onProgress) {
  const books = [];
  const queue = [{ id: rootId, category: null }];
  let scanned = 0;
  while (queue.length) {
    const { id, category } = queue.shift();
    const items = await listAll(`'${id}' in parents and trashed=false`);
    scanned++;
    onProgress && onProgress(scanned);
    for (const f of items) {
      if (f.mimeType === FOLDER) {
        queue.push({ id: f.id, category: category || f.name });
      } else {
        const format = formatOf(f.name);
        if (!format) continue;
        books.push({
          id: f.id, driveId: f.id, source: 'drive', format,
          fileName: f.name, title: cleanTitle(f.name), author: '',
          category: category || 'Без категории',
          size: +f.size || 0, modifiedTime: f.modifiedTime,
        });
      }
    }
  }
  return books;
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
