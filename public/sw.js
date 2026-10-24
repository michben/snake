/* Service Worker — Mich Snake : jeu jouable 100% hors-ligne */
const CACHE = 'mich-snake-v3';
const ASSETS = ['./', 'index.html', 'css/style.css', 'js/core.js', 'js/tower.js', 'js/audio.js', 'js/client.js', 'js/admin.js', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
    e.waitUntil(caches.keys()
        .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
        .then(() => self.clients.claim()));
});

// Réseau d'abord (pour toujours avoir la dernière version), cache en secours.
// Le trafic Socket.io n'est jamais mis en cache.
self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);
    if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/socket.io/') ||
        url.pathname.includes('/api/') || url.pathname.includes('/music/')) return;
    e.respondWith(
        fetch(e.request)
            .then((res) => {
                if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
                return res;
            })
            .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
    );
});
