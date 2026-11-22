// Сервис-воркер: приложение открывается без интернета.
const VERSION = 'reader-v8';
const CORE = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/db.js', 'js/store.js', 'js/drive.js', 'js/formats.js', 'js/reader.js', 'js/ui.js',
  'lib/jszip.min.js', 'lib/pdf.min.mjs', 'lib/pdf.worker.min.mjs', 'lib/mammoth.browser.min.js', 'lib/fflate.js', 'lib/mobi.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Google API и вход — только через сеть
  if (url.hostname.endsWith('googleapis.com') && !url.hostname.startsWith('fonts.')) return;
  if (url.hostname === 'accounts.google.com') return;
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin === location.origin || isFont) {
    // своё приложение: сначала сеть (чтобы обновления приходили), при отсутствии сети — кэш
    e.respondWith(
      fetch(e.request, url.origin === location.origin ? { cache: 'no-cache' } : undefined).then(res => {
        if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
        return res;
      }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
    );
  }
});
