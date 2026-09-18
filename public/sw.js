const CACHE = "gmc-shell-v2";
const SHELL = [
  "/", "/first.html", "/product.html", "/contact.html",
  "/service.html", "/media.html", "/admin.html", "/admin-dashboard.html"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Dynamic public data: show cached data immediately, refresh it in background.
  if (url.pathname === "/api/products" || url.pathname === "/api/contacts") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      const network = fetch(req).then(response => {
        if (response.ok) cache.put(req, response.clone());
        return response;
      }).catch(() => cached);
      return cached || network;
    })());
    return;
  }

  // Images: cache after first successful load.
  if (url.pathname === "/api/image-proxy") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      const response = await fetch(req);
      if (response.ok) cache.put(req, response.clone());
      return response;
    })());
    return;
  }

  // App pages: cache-first for repeat navigation, with network update.
  if (req.mode === "navigate" || url.pathname.endsWith(".html") || url.pathname === "/") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req) || await cache.match("/first.html");
      try {
        const response = await fetch(req);
        if (response.ok) cache.put(req, response.clone());
        return response;
      } catch {
        return cached || Response.error();
      }
    })());
  }
});
