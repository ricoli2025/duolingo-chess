const CACHE = 'duolingo-chess-v8';
const FILES = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest', 'assets/icon.svg',
  'assets/piece-templates.json', 'js/app.js', 'js/engine.js', 'js/recognition.js',
  ...[...'KQRBNPkqrbnp'].map((piece) => `assets/pieces/${piece}${piece === piece.toUpperCase() ? '.white' : ''}.png`),
  'vendor/chess.js', 'vendor/stockfish-19-lite-single.js', 'vendor/stockfish-19-lite-single.wasm'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then((cache) => cache.put(event.request, copy)));
      }
      return response;
    }).catch(() => caches.match(event.request))
  );
});
