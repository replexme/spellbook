/* SPDX-License-Identifier: MPL-2.0 */
const CACHE = "spellbook-office-lo-public-assets-v1";
const allowed = (url) =>
  url.origin === self.location.origin &&
  !url.searchParams.has("file") &&
  !url.searchParams.has("src") &&
  (/^\/(?:runtime|harness|office-session-spike|extensions|contracts)\//.test(
    url.pathname,
  ) ||
    [
      "/local-workspace.css",
      "/local-phone-view.mjs",
      "/design-system/tokens.css",
      "/design-system/base.css",
      "/design-system/components.css",
      "/design-system/patterns.css",
      "/workspace",
      "/local",
      "/local-workspace.mjs",
      "/local-file.mjs",
      "/local-ai.bundle.js",
    ].includes(url.pathname));
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || !allowed(url)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(event.request);
        if (response.status === 200)
          await cache.put(url.origin + url.pathname, response.clone());
        return response;
      } catch (error) {
        const cached = await cache.match(url.origin + url.pathname);
        if (cached) return cached;
        throw error;
      }
    })(),
  );
});
