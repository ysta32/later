const CACHE = "later-shell-v1";
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const response = await fetch("/", { cache: "reload" });
      if (!response.ok) throw new Error("Cannot cache app shell");
      const html = await response.clone().text();
      const assets = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
        .map((match) => new URL(match[1], self.location.origin))
        .filter((url) => url.origin === self.location.origin && url.pathname.startsWith("/assets/"))
        .map((url) => url.pathname);
      await cache.addAll(["/manifest.webmanifest", "/icon.svg", ...assets]);
      await cache.put("/", response);
    })(),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith("later-shell-") && key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname === "/api/articles") {
    // Network first; the app falls back to account-scoped IDB on transport failure.
    // Private API responses never enter the shared shell cache.
    event.respondWith(fetch(request));
    return;
  }
  if (url.pathname.startsWith("/api/") || url.pathname === "/share" || url.pathname === "/bookmarklet.js")
    return;
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const response = await fetch(request);
          if (response.ok) await cache.put("/", response.clone());
          return response;
        } catch {
          return (await cache.match("/")) ?? Response.error();
        }
      })(),
    );
  } else if (
    url.pathname.startsWith("/assets/") ||
    ["/icon.svg", "/manifest.webmanifest"].includes(url.pathname)
  ) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      })(),
    );
  }
});
