// Service worker: app offline, dati di mercato sempre freschi quando c'è rete
const VERSIONE = 'pl-v5';
const SHELL = ['./', 'index.html', 'motore.js', 'btp.html', 'btp-motore.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSIONE).then(c => c.addAll(SHELL)));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSIONE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin === location.origin && (url.pathname.endsWith('/mercato.json') || url.pathname.endsWith('/btp.json'))) {
    // rete prima, cache se offline
    e.respondWith(fetch(e.request, { cache: 'no-store' }).then(r => {
      const copia = r.clone();
      caches.open(VERSIONE).then(c => c.put(e.request.url, copia));
      return r;
    }).catch(() => caches.match(e.request.url)));
    return;
  }
  // tutto il resto (pagina, script, font): cache prima, poi rete
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
    if (r.ok && (url.origin === location.origin || url.host.includes('fonts.g'))) {
      const copia = r.clone();
      caches.open(VERSIONE).then(c => c.put(e.request, copia));
    }
    return r;
  })));
});
