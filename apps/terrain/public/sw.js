/*
 * Service worker de JAMYSTOCK Terrain : met en cache la coque de l'appli (HTML, JS, CSS, icônes)
 * pour qu'elle s'ouvre sans réseau. Les appels /api ne passent jamais par le cache : les données
 * hors-ligne vivent dans IndexedDB, sous le contrôle de l'appli.
 */
const CACHE = 'terrain-shell-v3';
// chemins relatifs à la portée du service worker (/terrain/ en production)
const BASE = new URL(self.registration.scope).pathname;
const SHELL = ['', 'index.html', 'manifest.webmanifest', 'icon.svg'].map((p) => BASE + p);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || !url.pathname.startsWith(BASE)) return;

  // Navigation : réseau d'abord (nouvelle version), sinon la coque en cache.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          void caches.open(CACHE).then((c) => c.put(BASE + 'index.html', copy));
          return res;
        })
        .catch(() => caches.match(BASE + 'index.html')),
    );
    return;
  }

  // Fichiers versionnés par Vite (/assets/*-hash.js) : cache d'abord, ils ne changent jamais.
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            void caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
