// Service worker — network-first. Nunca cachea la API ni respuestas de login.
const CACHE = 'otp-v1';
const ASSETS = ['/', '/style.css', '/app.js', '/manifest.json', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png'];

// Solo se guardan respuestas buenas y que no sean un redirect al login
function cacheable(res) {
  return res && res.ok && !res.redirected && res.type === 'basic';
}

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => Promise.all(ASSETS.map(async url => {
      try {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (cacheable(res)) await c.put(url, res);
      } catch { /* sin red: se llenará después */ }
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

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // API, login y fotos: siempre a la red (datos privados / siempre frescos)
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
