/* SPDX-License-Identifier: MPL-2.0 */
// Cache only immutable candidate program resources. Document/blob/API bytes
// remain governed by the exact-artifact and OPFS journal contracts.
const CACHE = "spellbook-office-public-assets-__RUNTIME_ID__";
const allowed = (url) =>
  url.origin === self.location.origin &&
  !url.searchParams.has("file") &&
  !url.searchParams.has("src") &&
  (/^\/(?:assets|npm|sdkjs|web-apps|wasm|fonts|libs)\//.test(url.pathname) ||
    [
      "/local",
      "/local-workspace.mjs",
      "/local-file.mjs",
      "/local-ai.bundle.js",
      "/workspace",
      "/workspace.bundle.js",
      "/office-host.html",
      "/sdk.bundle.js",
      "/comparison-repair.js",
      "/plugins.json",
      "/themes.json",
      "/onlyoffice-runtime-assets.json",
      "/onlyoffice-browser-font-assets.json",
      "/onlyoffice-browser-font-source-map.json",
      "/server/FileConverter/bin/font_selection.bin",
      "/reset.html",
    ].includes(url.pathname));
const key = (url) => url.origin + url.pathname;
// Worker-internal converter requests do not appear in Window performance
// entries. Retain these pinned public programs before claiming offline control.
const requiredPrograms = [
  "/wasm/x2t/x2t.js",
  "/wasm/x2t/x2t.wasm",
  "/wasm/x2t/conversion-worker-lKNm6_YF.js",
  "/wasm/x2t/startup-heartbeat-worker-CiG48tVf.js",
  "/sdkjs/common/hash/hash/engine.js",
  "/sdkjs/common/hash/hash/engine.wasm",
  "/sdkjs/common/libfont/engine/fonts.js",
  "/sdkjs/common/libfont/engine/fonts.wasm",
  "/sdkjs/common/spell/spell/spell.js",
  "/sdkjs/common/spell/spell/spell.wasm",
  "/sdkjs/common/zlib/engine/zlib.js",
  "/sdkjs/common/zlib/engine/zlib.wasm",
  "/libs/sheetjs/xlsx.full.min.js",
];
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(requiredPrograms);
      await self.skipWaiting();
    })(),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || !allowed(url)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(event.request);
        if (response.status === 200) {
          await cache.put(key(url), response.clone());
        }
        return response;
      } catch (error) {
        const cached = await cache.match(key(url));
        if (cached) return cached;
        throw error;
      }
    })(),
  );
});
