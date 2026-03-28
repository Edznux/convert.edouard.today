// sw.js — Service worker for offline-first caching

var CACHE_NAME = "fittogpx-v1";
var ASSETS = [
    "./",
    "./index.html",
    "./style.css",
    "./app.js",
    "./fit.js",
    "./gpx.js",
    "./manifest.json",
    "./icon.svg",
    "./icon-192.png",
    "./icon-512.png",
];

// Precache all assets on install
self.addEventListener("install", function (event) {
    event.waitUntil(
        caches.open(CACHE_NAME).then(function (cache) {
            return cache.addAll(ASSETS);
        })
    );
    self.skipWaiting();
});

// Clean up old caches on activate
self.addEventListener("activate", function (event) {
    event.waitUntil(
        caches.keys().then(function (keys) {
            return Promise.all(
                keys
                    .filter(function (key) {
                        return key !== CACHE_NAME;
                    })
                    .map(function (key) {
                        return caches.delete(key);
                    })
            );
        })
    );
    self.clients.claim();
});

// Cache-first strategy
self.addEventListener("fetch", function (event) {
    event.respondWith(
        caches.match(event.request).then(function (cached) {
            return cached || fetch(event.request);
        })
    );
});
