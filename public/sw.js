// Service worker — network-first. Never caches API or login responses.
const CACHE = 'otp-v6';
const ASSETS = ['/', '/style.css?v=5', '/app.js?v=5', '/manifest.json', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png'];

function cacheable(res) {
  return res && res.ok && !res.redirected && res.type === 'basic';
}

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => Promise.all(ASSETS.map(async url => {
      try {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (cacheable(res)) await c.put(url, res);
      } catch { /* offline: will fill later */ }
    })))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Tell all open tabs that a new version activated
self.addEventListener('activate', () => {
  self.clients.matchAll({ type: 'window' }).then(clients => {
    clients.forEach(c => c.postMessage({ type: 'SW_UPDATED' }));
  });
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/') ||
      url.pathname.startsWith('/login')) return;

  e.respondWith(
    fetch(req)
      .then(res => {
        if (cacheable(res)) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        if (req.mode === 'navigate') {
          const shell = await caches.match('/');
          if (shell) return shell;
        }
        return Response.error();
      })
  );
});
