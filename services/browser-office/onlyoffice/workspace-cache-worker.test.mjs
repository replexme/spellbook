/* SPDX-License-Identifier: MPL-2.0 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
const source = await fs.readFile(new URL("./workspace-cache-worker.js", import.meta.url), "utf8");
function worker(fonts, options = {}) {
  const handlers = {}, added = [];
  vm.runInNewContext(source, {
    URL,
    self: {location: {origin: "https://office.example"}, addEventListener: (type, handler) => handlers[type] = handler, skipWaiting: async () => {}, clients: {claim: async () => {}}},
    caches: {open: async () => ({addAll: async paths => added.push(...paths), ...options.cache})},
    fetch: options.fetch ?? (async () => ({ok: true, json: async () => fonts})),
  });
  return {handlers, added};
}
const fonts = {allFonts: "sdkjs/common/AllFonts.js", fontSelection: "server/FileConverter/bin/font_selection.bin", fontSourceMap: "onlyoffice-browser-font-source-map.json", fontThumbnails: ["sdkjs/common/Images/fonts_thumbnail.png", "sdkjs/common/Images/fonts_thumbnail_ea.png"], fonts: ["fonts/000.ttf"]};
test("offline install includes font validation and East Asian previews loaded before worker control", async () => {
  const {handlers, added} = worker(fonts);
  let installed;
  handlers.install({waitUntil: value => installed = value});
  await installed;
  for (const path of [fonts.allFonts, ...fonts.fontThumbnails, ...fonts.fonts]) assert(added.includes("/" + path));
});

function request(handlers, url = "https://office.example/sdkjs/slide/sdk-all.js", clientId = "page") {
  let response;
  handlers.fetch({request: {method: "GET", url}, clientId, respondWith: value => response = value});
  return response;
}
test("warm programs use the cache after one shared server-version check per client", async () => {
  const calls = [];
  const cached = {body: "pinned program"};
  const {handlers} = worker(fonts, {
    cache: {match: async () => cached},
    fetch: async (url, options) => {
      calls.push({url, options});
      return {ok: true, headers: {get: () => "__RUNTIME_ID__"}};
    },
  });
  assert.deepEqual(await Promise.all([request(handlers), request(handlers)]), [cached, cached]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/sw.js");
  assert.equal(calls[0].options.cache, "no-store");
});
test("an old controlling worker serves a new page from the server without contaminating its cache", async () => {
  const calls = [];
  const {handlers} = worker(fonts, {
    cache: {match: () => assert.fail("stale cache read"), put: () => assert.fail("new bytes stored in old cache")},
    fetch: async url => {
      calls.push(url);
      return url === "/sw.js"
        ? {ok: true, headers: {get: () => "new runtime"}}
        : {body: "new program"};
    },
  });
  assert.equal((await request(handlers)).body, "new program");
  assert.equal(calls.length, 2);
});
test("offline reopen keeps previously cached programs and never invents missing ones", async () => {
  const {handlers} = worker(fonts, {
    cache: {match: async url => url.endsWith("sdk-all.js") ? {body: "offline program"} : undefined},
    fetch: async () => {throw Error("offline");},
  });
  assert.equal((await request(handlers)).body, "offline program");
  await assert.rejects(request(handlers, "https://office.example/fonts/missing.ttf"), /offline/);
});
test("uncached programs are stored only on a successful same-version response", async () => {
  const stored = [];
  let status = 200;
  const {handlers} = worker(fonts, {
    cache: {match: async () => undefined, put: async (...value) => stored.push(value)},
    fetch: async url => url === "/sw.js"
      ? {ok: true, headers: {get: () => "__RUNTIME_ID__"}}
      : {status, clone: () => ({body: "new program"})},
  });
  await request(handlers);
  status = 404;
  await request(handlers, "https://office.example/fonts/missing.ttf");
  assert.equal(stored.length, 1);
});
test("font manifest cannot pull private or traversing paths into the program cache", async () => {
  const {handlers, added} = worker({...fonts, fonts: ["fonts/../api/documents/private"]});
  let installed;
  handlers.install({waitUntil: value => installed = value});
  await assert.rejects(installed, /offline_font_program_invalid/);
  assert.equal(added.length, 0);
});
test("program worker never intercepts writes, private document URLs or external origins", () => {
  const {handlers} = worker(fonts);
  for (const [method, url] of [["POST", "https://office.example/fonts/000.ttf"], ["GET", "https://office.example/api/documents/private"], ["GET", "https://office.example/assets/example.js?file=private"], ["GET", "https://other.example/fonts/000.ttf"]]) {
    handlers.fetch({request: {method, url}, respondWith: () => assert.fail("private traffic intercepted")});
  }
});
