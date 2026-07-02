
// ==============================================
// SERVICE WORKER — मल्लविद्या कुस्ती केंद्र V2
// Strategy: Cache-First for assets, Network-First for HTML
// ==============================================

const CACHE_NAME = 'mallavidya-v2';
const STATIC_ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './logo.jpg',
  './icon-192.png',
  './icon-512.png'
];

// Install: cache all static assets
self.addEventListener('install', (event) => {
  console.log('[SW V2] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.log('[SW V2] Cache addAll partial error (non-critical):', err);
      });
    }).then(() => {
      console.log('[SW V2] Installed & cached ✅');
      return self.skipWaiting();
    })
  );
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  console.log('[SW V2] Activating...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => {
            console.log('[SW V2] Deleting old cache:', name);
            return caches.delete(name);
          })
      );
    }).then(() => {
      console.log('[SW V2] Activated ✅');
      return self.clients.claim();
    })
  );
});

// Fetch: Cache-First with Network Fallback (Offline First)
self.addEventListener('fetch', (event) => {
  // Skip non-GET requests and cross-origin requests (CDNs etc.)
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // For same-origin requests: try cache first, then network
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) {
          // Update cache in background (stale-while-revalidate)
          const fetchPromise = fetch(event.request).then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              const responseClone = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(event.request, responseClone);
              });
            }
            return networkResponse;
          }).catch(() => null);

          return cachedResponse;
        }

        // Not in cache — fetch from network and cache it
        return fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        }).catch(() => {
          // Offline and not cached — return offline page for HTML
          if (event.request.destination === 'document') {
            return caches.match('./index.html');
          }
        });
      })
    );
  }
  // For cross-origin (fonts, CDNs): use network, cache on success
  else {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) return cachedResponse;
        return fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        }).catch(() => null);
      })
    );
  }
});
Pressing key...Clicking...Stopping...

Stop Agent
