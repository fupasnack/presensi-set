// service-worker.js — FUPA Snack PWA
const CACHE_NAME = 'fupa-snack-shell-v1';
const APP_SHELL = [
  '/index.html',
  '/karyawan.html',
  '/admin.html',
  '/app.js',
  '/manifest.webmanifest',
  'https://cdn-icons-png.flaticon.com/512/3075/3075977.png'
];

// Install: cache shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// Activate: hapus cache lama
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((key) => {
        if (key !== CACHE_NAME) return caches.delete(key);
      }))
    )
  );
  self.clients.claim();
});

// Fetch handler
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Cache-first untuk file shell
  if (APP_SHELL.some(path => url.pathname.endsWith(path.replace('/', '')))) {
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req))
    );
    return;
  }

  // Network-first untuk lainnya
  event.respondWith(
    fetch(req)
      .then((res) => {
        // Simpan ke cache untuk offline
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
        return res;
      })
      .catch(() => caches.match(req))
  );
});