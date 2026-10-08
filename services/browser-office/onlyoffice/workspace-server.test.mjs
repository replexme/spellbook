/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOnlyOfficeWorkspaceServer } from "./workspace-server.mjs";
import { chromium } from "@playwright/test";
const origins = {
  workspaceOrigin: "http://127.0.0.1:35602",
  sdkOrigin: "http://127.0.0.1:35616",
  inspectionOrigin: "http://127.0.0.1:35617",
  hostOrigins: ["https://spellbook.my"],
};
test("candidate requires three distinct exact origins and a parent allowlist", () => {
  const options = { distributionDirectory: ".", ...origins };
  for (const change of [
    { sdkOrigin: origins.workspaceOrigin },
    { inspectionOrigin: origins.sdkOrigin },
    { hostOrigins: [] },
    { workspaceOrigin: "https://spellbook.my/path" },
    { sdkOrigin: "http://public.example" },
  ])
    assert.throws(() =>
      createOnlyOfficeWorkspaceServer({ ...options, ...change }),
    );
});

test("real worker reuses public programs, rejects stale online bytes and preserves offline/private boundaries", {timeout: 30000}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spellbook-cache-browser-"));
  for (const file of ["sdk.bundle.js", "distribution-manifest.json", "workspace-source-receipt.json"])
    await writeFile(path.join(directory, file), "first release");
  const server = createOnlyOfficeWorkspaceServer({distributionDirectory: directory, bundleDirectory: directory, ...origins});
  const route = server.listeners("request")[0];
  server.removeAllListeners("request");
  let version = "first program";
  const requested = [];
  server.on("request", (req, res) => {
    const url = new URL(req.url, "http://localhost");
    requested.push(url.pathname);
    if (url.pathname === "/sw.js") return route(req, res);
    res.setHeader("cache-control", "no-store");
    if (url.pathname === "/onlyoffice-browser-font-assets.json") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({allFonts: "sdkjs/common/AllFonts.js", fontSelection: "server/FileConverter/bin/font_selection.bin", fontSourceMap: "onlyoffice-browser-font-source-map.json", fonts: []}));
    } else if (url.pathname === "/office-host.html") {
      res.setHeader("content-type", "text/html");
      res.end("<!doctype html><title>Cache lifecycle test</title>");
    } else res.end(version);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({headless: true, executablePath: process.env.SPELLBOOK_CHROMIUM_EXECUTABLE || undefined});
    const context = await browser.newContext({serviceWorkers: "allow"});
    const first = await context.newPage();
    await first.goto(base + "/office-host.html");
    const install = async page => {
      await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.register("/sw.js", {scope: "/", updateViaCache: "none"});
        await registration.update();
        const replacement = registration.installing ?? registration.waiting;
        if (replacement && replacement.state !== "activated") await new Promise((resolve, reject) => {
          replacement.addEventListener("statechange", () => {
            if (replacement.state === "activated") resolve();
            if (replacement.state === "redundant") reject(Error("worker install failed"));
          });
        });
        await navigator.serviceWorker.ready;
        if (navigator.serviceWorker.controller !== registration.active) await new Promise(resolve => {
          navigator.serviceWorker.addEventListener("controllerchange", () => {
            if (navigator.serviceWorker.controller === registration.active) resolve();
          });
        });
      });
    };
    const get = (page, url) => page.evaluate(async url => (await fetch(url)).text(), url);
    await install(first);
    assert.equal(await get(first, "/assets/cache-probe.js"), "first program");
    requested.length = 0;
    assert.equal(await get(first, "/assets/cache-probe.js"), "first program");
    assert(!requested.includes("/assets/cache-probe.js"));
    for (const url of ["/api/documents/private", "/assets/private.js?file=private", "/assets/private.js?src=private"])
      assert.equal(await get(first, url), "first program");
    const keys = await first.evaluate(async () => (await Promise.all((await caches.keys()).map(async name => (await (await caches.open(name)).keys()).map(r => r.url)))).flat());
    assert(!keys.some(url => url.includes("private")));
    version = "second program";
    await writeFile(path.join(directory, "workspace-source-receipt.json"), "second native patch release");
    const second = await context.newPage();
    await second.goto(base + "/office-host.html");
    assert.equal(await get(second, "/assets/cache-probe.js"), "second program");
    assert.equal(await get(first, "/assets/cache-probe.js"), "first program");
    await install(second);
    assert.equal(await get(second, "/assets/cache-probe.js"), "second program");
    // Prime this HTML for a wholly new offline client, not just an already-open tab.
    const warm = await context.newPage();
    await warm.goto(base + "/office-host.html");
    await context.setOffline(true);
    const offline = await context.newPage();
    await offline.goto(base + "/office-host.html");
    assert.equal(await get(offline, "/assets/cache-probe.js"), "second program");
    await assert.rejects(get(offline, "/api/documents/private"));
    await assert.rejects(get(offline, "/assets/never-cached.js"));
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, {recursive: true, force: true});
  }
});
test("candidate serves local files, exact parent policy, source disclosure and rejects encoded traversal", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "spellbook-host-routes-"),
  );
  await writeFile(
    path.join(directory, "workspace.bundle.js"),
    "export const proof=true;",
  );
  const server = createOnlyOfficeWorkspaceServer({
    distributionDirectory: directory,
    bundleDirectory: directory,
    ...origins,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + "/readyz")).status, 503);
    const workspace = await fetch(base + "/workspace");
    assert.equal(workspace.status, 200);
    assert.equal(
      workspace.headers.get("content-security-policy"),
      "frame-ancestors 'self' https://spellbook.my http://127.0.0.1:35602",
    );
    const html = await workspace.text();
    assert.deepEqual(
      JSON.parse(html.match(/application\/json">(.*?)<\/script>/s)[1])
        .hostOrigins,
      [...origins.hostOrigins, origins.workspaceOrigin],
    );
    assert.match(
      await (await fetch(base + "/local")).text(),
      /local-workspace.mjs/,
    );
    assert.match(
      await (await fetch(base + "/licenses")).text(),
      /not admitted for public distribution/,
    );
    assert.equal(
      await (await fetch(base + "/workspace.bundle.js")).text(),
      "export const proof=true;",
    );
    assert.equal((await fetch(base + "/missing.js")).status, 404);
    const denied = await fetch(base + "/%2e%2e%2fpackage.json");
    assert.equal(denied.status, 500);
    assert.equal(await denied.text(), "");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("offline program cache identity changes when auxiliary runtime identity changes", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "spellbook-program-cache-"),
  );
  await writeFile(
    path.join(directory, "sdk.bundle.js"),
    "same SDK integration",
  );
  await writeFile(path.join(directory, "workspace-source-receipt.json"), "same host and native patch source");
  await writeFile(
    path.join(directory, "onlyoffice-runtime-assets.json"),
    JSON.stringify({ selected: 1681 }),
  );
  const manifest = (hash) =>
    JSON.stringify({
      files: [{ path: "sdkjs/common/libfont/engine/fonts.wasm", sha256: hash }],
    });
  await writeFile(
    path.join(directory, "distribution-manifest.json"),
    manifest("first compiled font"),
  );
  const server = createOnlyOfficeWorkspaceServer({
    distributionDirectory: directory,
    bundleDirectory: directory,
    ...origins,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await (await fetch(base + "/sw.js")).text();
    await writeFile(
      path.join(directory, "distribution-manifest.json"),
      manifest("new compiled font"),
    );
    const second = await (await fetch(base + "/sw.js")).text();
    assert.notEqual(second, first);
    assert.equal(
      second.replace(/[a-f0-9]{64}/gu, "version"),
      first.replace(/[a-f0-9]{64}/gu, "version"),
    );
    await writeFile(path.join(directory, "workspace-source-receipt.json"), "changed host or native patch source");
    const third = await (await fetch(base + "/sw.js")).text();
    assert.notEqual(third, second);
    const response = await fetch(base + "/sw.js");
    assert.match(response.headers.get("X-Spellbook-Runtime-Identity"), /^[a-f0-9]{64}$/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const other = createOnlyOfficeWorkspaceServer({
      distributionDirectory: directory, bundleDirectory: directory, ...origins,
      hostOrigins: ["https://different.spellbook.my"],
    });
    await new Promise(resolve => other.listen(0, "127.0.0.1", resolve));
    try {
      const otherWorker = await fetch(`http://127.0.0.1:${other.address().port}/sw.js`);
      assert.notEqual(otherWorker.headers.get("X-Spellbook-Runtime-Identity"), response.headers.get("X-Spellbook-Runtime-Identity"));
    } finally {
      other.closeAllConnections();
      await new Promise(resolve => other.close(resolve));
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
