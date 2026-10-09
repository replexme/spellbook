/* SPDX-License-Identifier: MPL-2.0 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { webcrypto, createHash } from "node:crypto";
const source = await fs.readFile(
  new URL("./workspace-cache-worker.js", import.meta.url),
  "utf8",
);
const required = vm.runInNewContext(
  source.match(/const requiredPrograms = \[[\s\S]*?\];/)[0] +
    "requiredPrograms",
);
const version = "__RUNTIME_ID__",
  prefix = "spellbook-office-public-assets-",
  origin = "https://office.example";
const fonts = {
  allFonts: "sdkjs/common/AllFonts.js",
  fontSelection: "server/FileConverter/bin/font_selection.bin",
  fontSourceMap: "onlyoffice-browser-font-source-map.json",
  fontThumbnails: ["sdkjs/common/Images/fonts_thumbnail_ea.png"],
  fonts: ["fonts/000.ttf"],
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function worker(options = {}) {
  const bodies = new Map(
    [
      ...required,
      ...Object.values(fonts)
        .flat()
        .map((p) => "/" + p),
    ].map((p) => [p, "public " + p]),
  );
  bodies.set(
    "/onlyoffice-browser-font-assets.json",
    JSON.stringify(options.fonts ?? fonts),
  );
  bodies.set("/sdkjs/slide/sdk-all.js", "native public SDK");
  const hashes = Object.fromEntries([...bodies].map(([p, b]) => [p, hash(b)]));
  Object.assign(hashes, options.hashes);
  const maps = new Map(),
    calls = [],
    handlers = {},
    removed = [];
  const absolute = (value) =>
    new URL(typeof value === "string" ? value : value.url, origin).href;
  const open = async (name) => {
    if (!maps.has(name)) maps.set(name, new Map());
    const map = maps.get(name);
    return {
      match: async (key) => map.get(absolute(key))?.clone(),
      put: async (key, response) => map.set(absolute(key), response.clone()),
      keys: async () => [...map.keys()].map((url) => ({ url })),
    };
  };
  const fetch =
    options.fetch ??
    (async (path, init) => {
      if (typeof path !== "string") path = new URL(path.url).pathname;
      calls.push({ path, init });
      if (path === "/sw.js")
        return new Response(null, {
          headers: {
            "X-Spellbook-Runtime-Identity": options.serverVersion ?? version,
          },
        });
      if (path === "/public-programs.json")
        return Response.json({
          runtimeIdentity: options.manifestVersion ?? version,
          hashes,
        });
      return bodies.has(path)
        ? new Response(bodies.get(path))
        : new Response(null, { status: 404 });
    });
  let activated = false;
  vm.runInNewContext(source, {
    URL,
    crypto: webcrypto,
    Uint8Array,
    self: {
      location: { origin },
      addEventListener: (type, handler) => (handlers[type] = handler),
      skipWaiting: async () => {
        activated = true;
      },
      clients: { claim: async () => {} },
    },
    caches: {
      open,
      keys: async () => [...maps.keys()],
      delete: async (name) => {
        removed.push(name);
        return maps.delete(name);
      },
    },
    fetch,
  });
  return {
    handlers,
    maps,
    bodies,
    calls,
    hashes,
    open,
    removed,
    activated: () => activated,
    install: () => {
      let pending;
      handlers.install({ waitUntil: (p) => (pending = p) });
      return pending;
    },
  };
}
function request(
  handlers,
  path = "/sdkjs/slide/sdk-all.js",
  clientId = "page",
) {
  let pending;
  handlers.fetch({
    request: { method: "GET", url: origin + path },
    clientId,
    respondWith: (p) => (pending = p),
  });
  return pending;
}

test("verified install includes native worker programs, public faces and East Asian font previews", async () => {
  const w = worker();
  await w.install();
  const cache = await w.open(prefix + version);
  for (const path of [
    ...required,
    ...fonts.fontThumbnails.map((p) => "/" + p),
    ...fonts.fonts.map((p) => "/" + p),
  ])
    assert.equal(await (await cache.match(path)).text(), w.bodies.get(path));
  assert(w.activated());
});

test("new releases reuse exact required and already warm public bytes, fetching only changed programs", async () => {
  const w = worker(),
    prior = await w.open(prefix + "old");
  for (const [path, body] of w.bodies)
    await prior.put(path, new Response(body));
  await prior.put("/document-font-worker.js", new Response("old worker"));
  await prior.put("/fonts/document-private.ttf", new Response("private"));
  await prior.put("/assets/obsolete.js", new Response("obsolete"));
  await w.install();
  assert.deepEqual(
    w.calls
      .filter((c) => c.path !== "/public-programs.json")
      .map((c) => c.path),
    ["/document-font-worker.js"],
  );
  const next = await w.open(prefix + version);
  assert.equal(
    await (await next.match("/sdkjs/slide/sdk-all.js")).text(),
    w.bodies.get("/sdkjs/slide/sdk-all.js"),
  );
  assert.equal(await next.match("/fonts/document-private.ttf"), undefined);
  assert.equal(await next.match("/assets/obsolete.js"), undefined);
});

test("a corrupt cached program is fetched again and the prior cache remains intact", async () => {
  const w = worker(),
    prior = await w.open(prefix + "old");
  for (const [path, body] of w.bodies)
    await prior.put(path, new Response(body));
  await prior.put("/wasm/x2t/x2t.wasm", new Response("corrupt"));
  await w.install();
  assert.deepEqual(
    w.calls
      .filter((c) => c.path !== "/public-programs.json")
      .map((c) => c.path),
    ["/wasm/x2t/x2t.wasm"],
  );
  assert.equal(
    await (await prior.match("/wasm/x2t/x2t.wasm")).text(),
    "corrupt",
  );
});

test("failed response identity rejects replacement, removes all partial writes and keeps prior cache", async () => {
  const w = worker({ hashes: { "/document-font-worker.js": "0".repeat(64) } });
  const prior = await w.open(prefix + "old");
  await prior.put("/assets/old.js", new Response("old"));
  await assert.rejects(w.install(), /identity_mismatch/);
  assert(!w.activated());
  assert(!w.maps.has(prefix + version));
  assert(w.maps.has(prefix + "old"));
  assert.deepEqual(w.removed, [prefix + version]);
});

test("a manifest from another release cannot install or replace the verified runtime", async () => {
  const w = worker({ manifestVersion: "another-release" });
  await assert.rejects(w.install(), /version_mismatch/);
  assert(!w.activated());
  assert(!w.maps.has(prefix + version));
});

test("font manifest cannot pull private or traversing paths into the public cache", async () => {
  const w = worker({
    fonts: { ...fonts, fonts: ["fonts/../api/documents/private"] },
  });
  await assert.rejects(w.install(), /offline_font_program_invalid/);
  assert(!w.maps.has(prefix + version));
  assert(!w.activated());
});

test("warm requests share one lightweight server-version check per client", async () => {
  const w = worker(),
    cache = await w.open(prefix + version);
  await cache.put("/sdkjs/slide/sdk-all.js", new Response("pinned"));
  const responses = await Promise.all([
    request(w.handlers),
    request(w.handlers),
  ]);
  assert.deepEqual(await Promise.all(responses.map((r) => r.text())), [
    "pinned",
    "pinned",
  ]);
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0].path, "/sw.js");
  assert.equal(w.calls[0].init.method, "HEAD");
  assert.equal(w.calls[0].init.cache, "no-store");
});

test("an old controlling worker reads a new page from the server without changing its old cache", async () => {
  const w = worker({ serverVersion: "new" }),
    cache = await w.open(prefix + version);
  await cache.put("/sdkjs/slide/sdk-all.js", new Response("old"));
  assert.equal(
    await (await request(w.handlers)).text(),
    w.bodies.get("/sdkjs/slide/sdk-all.js"),
  );
  assert.equal(
    await (await cache.match("/sdkjs/slide/sdk-all.js")).text(),
    "old",
  );
});

test("offline reopen retains only previously cached programs", async () => {
  const w = worker({
      fetch: async () => {
        throw Error("offline");
      },
    }),
    cache = await w.open(prefix + version);
  await cache.put("/sdkjs/slide/sdk-all.js", new Response("offline program"));
  assert.equal(await (await request(w.handlers)).text(), "offline program");
  await assert.rejects(request(w.handlers, "/fonts/missing.ttf"), /offline/);
});

test("program worker never intercepts writes, private inputs or external origins", () => {
  const w = worker();
  for (const [method, url] of [
    ["POST", origin + "/fonts/000.ttf"],
    ["GET", origin + "/api/documents/private"],
    ["GET", origin + "/assets/example.js?file=private"],
    ["GET", origin + "/assets/example.js?src=private"],
    ["GET", origin + "/fonts/document-private.ttf"],
    ["GET", origin + "/fonts//document-private.ttf"],
    ["GET", "https://other.example/fonts/000.ttf"],
  ])
    w.handlers.fetch({
      request: { method, url },
      respondWith: () => assert.fail("private traffic intercepted"),
    });
});

test("SDK worker URL aliases reuse their existing verified release without downloading it again", async () => {
  const w = worker(),
    current = await w.open(prefix + version);
  for (const [path, body] of w.bodies)
    await current.put(path, new Response(body));
  await w.install();
  assert.deepEqual(
    w.calls.map((c) => c.path),
    ["/public-programs.json"],
  );
  assert(w.activated());
});

test("a failed alias installation never deletes the already active release cache", async () => {
  const w = worker({ hashes: { "/document-font-worker.js": "0".repeat(64) } }),
    current = await w.open(prefix + version);
  for (const [path, body] of w.bodies)
    await current.put(path, new Response(body));
  await assert.rejects(w.install(), /identity_mismatch/);
  assert(w.maps.has(prefix + version));
  assert.deepEqual(w.removed, []);
  assert.equal(
    await (await current.match("/document-font-worker.js")).text(),
    w.bodies.get("/document-font-worker.js"),
  );
});

test("native doubled-slash theme requests use the exact canonical warm program", async () => {
  const w = worker(),
    cache = await w.open(prefix + version);
  await cache.put(
    "/sdkjs/slide/themes/themes.js",
    new Response("native theme catalog"),
  );
  assert.equal(
    await (await request(w.handlers, "/sdkjs/slide/themes//themes.js")).text(),
    "native theme catalog",
  );
  assert.deepEqual(
    w.calls.map((c) => c.path),
    ["/sw.js"],
  );
});
