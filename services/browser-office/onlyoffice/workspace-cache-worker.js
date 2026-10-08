/* SPDX-License-Identifier: MPL-2.0 */
// Cache only immutable candidate program resources. Document/blob/API bytes
// remain governed by the exact-artifact and OPFS journal contracts.
const VERSION = "__RUNTIME_ID__";
const CACHE = "spellbook-office-public-assets-" + VERSION;
const allowed = (url) =>
  url.origin === self.location.origin &&
  !url.searchParams.has("file") &&
  !url.searchParams.has("src") &&
  (/^\/(?:assets|npm|sdkjs|web-apps|wasm|fonts|libs)\//.test(url.pathname) ||
    [
      "/local-workspace.css",
      "/local-phone-view.mjs",
      "/design-system/tokens.css",
      "/design-system/base.css",
      "/design-system/components.css",
      "/design-system/patterns.css",
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
      // Font previews can load before the first SDK page is controlled by
      // this worker. Korean UI initialization checks the East Asian previews
      // again on reopen, so caching only later observed requests is incomplete.
      const fontManifestUrl = "/onlyoffice-browser-font-assets.json";
      const response = await fetch(fontManifestUrl);
      if (!response.ok) throw Error("offline_font_manifest_unavailable");
      const fonts = await response.json();
      const fontPrograms = [fonts.allFonts, fonts.fontSelection, fonts.fontSourceMap,
        ...(fonts.fontThumbnails ?? []), ...(fonts.fonts ?? [])];
      if (fontPrograms.some(path => typeof path !== "string" ||
        !/^(?:sdkjs|server|fonts|onlyoffice-browser-font-source-map\.json)/.test(path) ||
        path.startsWith("/") || path.split("/").includes("..") || /[?#\\]/.test(path)))
        throw Error("offline_font_program_invalid");
      await cache.addAll([...requiredPrograms, fontManifestUrl, ...fontPrograms.map(path => "/" + path)]);
      await self.skipWaiting();
    })(),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
// Paths are stable across releases. An older worker can control a new page
// before its replacement activates, so check that page's server identity
// before serving cached programs. Share the check among concurrent requests.
const clientVersions = new Map();
async function currentVersion(event) {
  const client = event.resultingClientId || event.clientId;
  let check = client && clientVersions.get(client);
  if (!check) {
    check = fetch("/sw.js", { cache: "no-store" }).then(
      response => response.ok && response.headers.get("X-Spellbook-Runtime-Identity") === VERSION,
      // A previously verified program remains usable while offline.
      () => true,
    );
    if (client) {
      if (clientVersions.size >= 256) clientVersions.delete(clientVersions.keys().next().value);
      clientVersions.set(client, check);
    }
  }
  return check;
}
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || !allowed(url)) return;
  event.respondWith(
    (async () => {
      if (!await currentVersion(event)) return fetch(event.request);
      const cache = await caches.open(CACHE);
      const cached = await cache.match(key(url));
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.status === 200) {
        await cache.put(key(url), response.clone());
      }
      return response;
    })(),
  );
});
