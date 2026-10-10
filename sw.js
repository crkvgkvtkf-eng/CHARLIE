/* Service worker: cache-first app shell so the app opens offline.
 * Bump CACHE whenever any precached asset changes.
 * PRECACHE must list every file under css/, js/, vendor/*.js and icons/ (tests/unit/sw.test.js
 * checks it against disk): add an entry whenever a module or stylesheet is added. */
const CACHE = 'ssb-v4';
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/ids.js',
  './js/lib.js',
  './js/model.js',
  './js/storage.js',
  './js/sync.js',
  './js/syncManager.js',
  './js/store.js',
  './js/timing.js',
  './js/ui/App.js',
  './js/ui/Board.js',
  './js/ui/SetPanel.js',
  './js/ui/Settings.js',
  './js/ui/Versions.js',
  './js/ui/common.js',
  './js/ui/dnd.js',
  './js/undo.js',
  './vendor/hooks.module.js',
  './vendor/htm.module.js',
  './vendor/preact.module.js',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // Add one by one so a single missing optional asset cannot fail the whole install.
      Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => undefined))),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('ssb-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // api.github.com etc.: network only, never cached

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => undefined);
          return res;
        })
        .catch(() => caches.match('./index.html', { ignoreSearch: true })),
    );
    return;
  }

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
        }
        return res;
      });
    }),
  );
});
