/* SPDX-License-Identifier: MPL-2.0 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
const source = await fs.readFile(new URL("./workspace-cache-worker.js", import.meta.url), "utf8");
function worker(fonts) {
  const handlers = {}, added = [];
  vm.runInNewContext(source, {
    URL,
    self: {location: {origin: "https://office.example"}, addEventListener: (type, handler) => handlers[type] = handler, skipWaiting: async () => {}, clients: {claim: async () => {}}},
    caches: {open: async () => ({addAll: async paths => added.push(...paths)})},
    fetch: async () => ({ok: true, json: async () => fonts}),
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
