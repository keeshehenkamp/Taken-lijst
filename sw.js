/* ================================================================
   SERVICE WORKER — offline caching voor Takenlijst PWA
   Strategie: cache-first voor alle app-bestanden.
   Bij een update wordt de cache automatisch ververst.
   ================================================================ */

const CACHE_NAME = 'takenlijst-v1';

// Alle bestanden die gecacht worden bij installatie
const FILES_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon.svg',
  // Google Fonts worden apart gecacht als ze beschikbaar zijn
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Source+Serif+4:wght@400;500;600&display=swap',
];

// Bij installatie: alle bestanden vooraf in de cache plaatsen
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Voeg de eigen bestanden toe; negeer fouten bij externe resources
      return cache.addAll(FILES_TO_CACHE).catch(() => {
        // Valt terug op alleen de lokale bestanden als de fonts niet laden
        return cache.addAll(['./', './index.html', './style.css', './app.js', './manifest.json', './icon.svg']);
      });
    })
  );
  // Activeer direct zonder te wachten op sluiten van oude tabbladen
  self.skipWaiting();
});

// Bij activatie: verwijder oude caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Bij een fetch-verzoek: cache-first, daarna netwerk
self.addEventListener('fetch', (event) => {
  // Sla POST-verzoeken en chrome-extension-URLs over
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      // Niet in cache: haal op via netwerk en sla op
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
