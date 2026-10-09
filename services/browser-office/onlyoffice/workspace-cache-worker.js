/* SPDX-License-Identifier: MPL-2.0 */
// Cache only immutable candidate program resources. Document/blob/API bytes
// remain governed by the exact-artifact and OPFS journal contracts.
const VERSION = "__RUNTIME_ID__";
const CACHE = "spellbook-office-public-assets-" + VERSION;
const allowed = (url) =>
  url.origin === self.location.origin &&
  !url.searchParams.has("file") &&
  !url.searchParams.has("src") &&
  !url.pathname.startsWith("/fonts/document-") &&
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
      "/document-fonts.bundle.js",
      "/document-font-worker.js",
      "/document-font-coverage.mjs",
      "/document-font-selection.mjs",
      "/eot/eot-decoder.mjs",
      "/eot/eot-decoder.wasm",
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
  "/document-fonts.bundle.js",
  "/document-font-worker.js",
  "/document-font-coverage.mjs",
  "/document-font-selection.mjs",
  "/eot/eot-decoder.mjs",
  "/eot/eot-decoder.wasm",
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
      const cacheNames = await caches.keys();
      const existed = cacheNames.includes(CACHE);
      const cache = await caches.open(CACHE);
      try {
        const identitiesResponse = await fetch("/public-programs.json", {
          cache: "no-store",
        });
        if (!identitiesResponse.ok)
          throw Error("public_program_manifest_unavailable");
        const manifest = await identitiesResponse.json();
        if (
          manifest.runtimeIdentity !== VERSION ||
          !manifest.hashes ||
          typeof manifest.hashes !== "object"
        )
          throw Error("public_program_manifest_version_mismatch");
        const previous = cacheNames
          .filter((name) => name.startsWith("spellbook-office-public-assets-"))
          .reverse();
        const priorCaches = await Promise.all(
          previous.map((name) => caches.open(name)),
        );
        const digest = async (response) =>
          Array.from(
            new Uint8Array(
              await crypto.subtle.digest(
                "SHA-256",
                await response.clone().arrayBuffer(),
              ),
            ),
            (n) => n.toString(16).padStart(2, "0"),
          ).join("");
        const retain = async (pathname) => {
          const url = new URL(pathname, self.location.origin),
            expected = manifest.hashes[pathname];
          if (!allowed(url) || !/^[a-f0-9]{64}$/.test(expected ?? ""))
            throw Error("public_program_identity_invalid");
          let accepted;
          for (const prior of priorCaches) {
            const response = await prior.match(key(url));
            if (
              response?.status === 200 &&
              (await digest(response)) === expected
            ) {
              accepted = response;
              break;
            }
          }
          if (!accepted) {
            accepted = await fetch(pathname, { cache: "reload" });
            if (
              accepted.status !== 200 ||
              (await digest(accepted)) !== expected
            )
              throw Error("public_program_identity_mismatch");
          }
          await cache.put(key(url), accepted.clone());
          return accepted;
        };
        const fontManifestUrl = "/onlyoffice-browser-font-assets.json";
        const fonts = await (await retain(fontManifestUrl)).json();
        const fontPrograms = [
          fonts.allFonts,
          fonts.fontSelection,
          fonts.fontSourceMap,
          ...(fonts.fontThumbnails ?? []),
          ...(fonts.fonts ?? []),
        ];
        if (
          fontPrograms.some(
            (path) =>
              typeof path !== "string" ||
              !/^(?:sdkjs|server|fonts|onlyoffice-browser-font-source-map\.json)/.test(
                path,
              ) ||
              path.startsWith("/") ||
              path.split("/").includes("..") ||
              /[?#\\]/.test(path),
          )
        )
          throw Error("offline_font_program_invalid");
        const paths = new Set([
          ...requiredPrograms,
          ...fontPrograms.map((path) => "/" + path),
        ]);
        // Retain already warm public editor files too. Every copied response
        // must match this release; private URLs and obsolete paths are omitted.
        for (const prior of priorCaches)
          for (const request of await prior.keys()) {
            const url = new URL(request.url);
            if (allowed(url) && manifest.hashes[url.pathname])
              paths.add(url.pathname);
          }
        paths.delete(fontManifestUrl);
        const entries = [...paths];
        let next = 0,
          failed = false;
        const results = await Promise.allSettled(
          Array.from({ length: 6 }, async () => {
            while (!failed && next < entries.length) {
              const pathname = entries[next++];
              try {
                await retain(pathname);
              } catch (error) {
                failed = true;
                throw error;
              }
            }
          }),
        );
        const failure = results.find((result) => result.status === "rejected");
        if (failure) throw failure.reason;
      } catch (error) {
        // Wait for all install writes to settle before deleting the partial
        // cache. A failed replacement never activates or damages the old one.
        // The SDK has worker URL aliases. Re-registering the same release
        // may already own this verified cache; never delete that active one.
        if (!existed) await caches.delete(CACHE);
        throw error;
      }
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
    check = fetch("/sw.js", { method: "HEAD", cache: "no-store" }).then(
      (response) =>
        response.ok &&
        response.headers.get("X-Spellbook-Runtime-Identity") === VERSION,
      // A previously verified program remains usable while offline.
      () => true,
    );
    if (client) {
      if (clientVersions.size >= 256)
        clientVersions.delete(clientVersions.keys().next().value);
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
      if (!(await currentVersion(event))) return fetch(event.request);
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
