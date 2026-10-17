// AmbilTiketnya Service Worker - v1
const CACHE = 'atk-v1';
const STATIC = [
  '/',
  '/index.html',
  '/config.js',
  '/scan.html',
  '/offline.html'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(STATIC))
      .catch(() => {}) // abaikan error, tetap install
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks =>
      Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // 1. API Apps Script → selalu network, JANGAN cache (data selalu fresh)
  if (url.hostname === 'script.google.com') return;

  // 2. Font Google / CDN cloudflare → stale-while-revalidate
  if (url.hostname.includes('googleapis.com') ||
      url.hostname.includes('gstatic.com') ||
      url.hostname.includes('cloudflare.com')) {
    e.respondWith(
      caches.open(CACHE).then(c =>
        c.match(e.request).then(hit => {
          const net = fetch(e.request).then(r => {
            if (r.ok) c.put(e.request, r.clone());
            return r;
          }).catch(() => hit);
          return hit || net;
        })
      )
    );
    return;
  }

  // 3. Aset lokal (index.html, config.js, dll) → network-first, fallback cache
  e.respondWith(
    fetch(e.request)
      .then(r => {
        if (r.ok) {
          const clone = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return r;
      })
      .catch(() =>
        caches.match(e.request)
          .then(hit => hit || caches.match('/offline.html'))
      )
  );
});
