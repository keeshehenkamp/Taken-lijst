/* ================================================================
   SERVICE WORKER — offline caching voor Takenlijst PWA

   Strategie:
     - App-bestanden (HTML/CSS/JS/icoon): cache-first
     - Firebase + Google APIs: altijd netwerk (geen cache),
       zodat auth en realtime sync goed blijven werken
   ================================================================ */

const CACHE_NAME = 'takenlijst-v18';

const FILES_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './firebase-sync.js',
  './manifest.json',
  './icon.svg',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Source+Serif+4:wght@400;500;600&display=swap',
];

// Hostnames waar het service worker nooit aan moet zitten
const NETWORK_ONLY_HOSTS = [
  'firebaseapp.com',
  'firebaseio.com',
  'firebase.googleapis.com',
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'apis.google.com',
  'accounts.google.com',
  'gstatic.com',  // Firebase SDK wordt hier vandaan geladen; door browser zelf gecacht
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Probeer alles te cachen; valt terug op alleen de lokale bestanden bij fout
      return cache.addAll(FILES_TO_CACHE).catch(() =>
        cache.addAll([
          './', './index.html', './style.css',
          './app.js', './firebase-sync.js',
          './manifest.json', './icon.svg',
        ])
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;

  const url = new URL(event.request.url);

  // Firebase/Google: nooit door de service worker — altijd netwerk
  if (NETWORK_ONLY_HOSTS.some((host) => url.hostname.endsWith(host))) {
    return; // browser handelt het zelf af
  }

  // Voor alle andere requests: cache-first
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type === 'opaque') {
          return response;
        }
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      });
    })
  );
});
