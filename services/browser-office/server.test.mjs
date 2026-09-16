import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildRoutes,
  configuredServerPort,
  createHarnessServer,
} from "./server.mjs";

const upstream = JSON.parse(
  readFileSync(new URL("./upstream.json", import.meta.url), "utf8"),
);

test("browser Office routes preserve isolation, asset identity and encodings", () => {
  const routes = buildRoutes();
  assert.ok(routes.has("/workspace"));
  assert.ok(routes.has("/runtime/soffice.js"));
  assert.ok(routes.has("/runtime/zeta.js"));
  assert.ok(routes.has("/runtime/ooxml-worker.js"));
  assert.ok(routes.has("/runtime/browser-candidate.js"));
  assert.ok(routes.has("/harness/opfs-journal.mjs"));
  assert.ok(routes.has("/harness/save-transaction.mjs"));
  assert.ok(routes.has("/harness/product-persistence.mjs"));
  assert.ok(routes.has("/harness/persistence-evidence.mjs"));
  assert.ok(routes.has("/harness/document-state-evidence.mjs"));
  assert.ok(routes.has("/harness/runtime-admission.js"));
  assert.ok(routes.has("/harness/mutation-contract.generated.js"));
  assert.ok(routes.has("/harness/operations.js"));
  assert.ok(routes.has("/harness/native-transform-adapter.js"));
  assert.equal(
    routes.get("/runtime/soffice.wasm").headers["Content-Encoding"],
    "br",
  );
  assert.equal(
    routes.get("/runtime/soffice.wasm").headers["Content-Type"],
    "application/wasm",
  );
  assert.equal(
    routes.get("/runtime/zeta.js").headers["Cache-Control"],
    "public, max-age=31536000, immutable",
  );
});

test("every static harness import in the workspace entrypoint is served", () => {
  const routes = buildRoutes();
  const entrypoint = readFileSync(
    new URL("./harness/app.js", import.meta.url),
    "utf8",
  );
  const importedPaths = [
    ...entrypoint.matchAll(/from\s+["'](\/harness\/[^"']+)["']/gu),
    ...entrypoint.matchAll(/import\s+["'](\/harness\/[^"']+)["']/gu),
  ].map((match) => match[1]);
  assert.ok(importedPaths.length > 0);
  for (const importedPath of importedPaths)
    assert.ok(routes.has(importedPath), `${importedPath} has no server route`);
});

test("candidate verification routes raw artifacts and an in-memory identity", () => {
  const runtimeIdentity = {
    buildCommit: "candidate",
    candidateCommit: "candidate",
    patchLevel: upstream.sourceCandidate.patchLevel,
    buildReady: true,
    nativeSlideStructureReady: false,
  };
  const candidate = {
    ...upstream,
    runtimeAssets: upstream.runtimeAssets.map((asset) => ({
      ...asset,
      storedPath: path.basename(asset.path),
      contentEncoding: undefined,
    })),
  };
  const routes = buildRoutes(import.meta.dirname, candidate, {
    runtimeRoot: "/tmp/spellbook-candidate-runtime",
    runtimeIdentity,
  });
  assert.equal(
    routes.get("/runtime/soffice.wasm").file,
    "/tmp/spellbook-candidate-runtime/soffice.wasm",
  );
  assert.equal(
    routes.get("/runtime/soffice.wasm").headers["Content-Encoding"],
    undefined,
  );
  assert.match(
    routes.get("/runtime/browser-candidate.js").body,
    /"buildReady":true/u,
  );
  assert.equal(
    routes.get("/runtime/zeta.js").file,
    path.join(import.meta.dirname, "runtime/zeta.js"),
  );
});

test("browser Office container honors PORT while CLI remains authoritative", () => {
  assert.equal(
    configuredServerPort(["node", "server.mjs"], { PORT: "8080" }),
    8080,
  );
  assert.equal(
    configuredServerPort(["node", "server.mjs", "--port", "4174"], {
      PORT: "8080",
    }),
    4174,
  );
  assert.throws(
    () => configuredServerPort(["node", "server.mjs"], { PORT: "invalid" }),
    /PORT must be an integer/u,
  );
});

test("browser Office server emits the required cross-origin isolation headers", async () => {
  const server = createHarnessServer({
    hostOrigin: "https://present.example",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("cross-origin-opener-policy"),
      "same-origin",
    );
    assert.equal(
      response.headers.get("cross-origin-embedder-policy"),
      "require-corp",
    );
    assert.equal(
      response.headers.get("cross-origin-resource-policy"),
      "cross-origin",
    );
    const html = await response.text();
    assert.match(html, /id="qtcanvas"/u);
    assert.match(html, /src="\/harness\/app\.js"/u);
    assert.match(html, /href="\/harness\/styles\.css"/u);

    const workspace = await fetch(`http://127.0.0.1:${address.port}/workspace`);
    assert.equal(workspace.status, 200);
    assert.equal(
      workspace.headers.get("content-security-policy"),
      "frame-ancestors 'self' https://present.example",
    );

    const ready = await fetch(`http://127.0.0.1:${address.port}/readyz`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), {
      status: "ok",
      protocolVersion: 1,
      buildCommit: upstream.source.buildCommit,
      candidateCommit: upstream.source.candidateCommit,
      ...upstream.sourceCandidate,
    });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("browser conformance reuses an exact fixture and captures one PPTX save", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "spellbook-browser-probe-"),
  );
  const source = path.join(root, "source.pptx");
  const output = path.join(root, "saved.pptx");
  const sourceBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]);
  const savedBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 2]);
  await writeFile(source, sourceBytes);
  const server = createHarnessServer({
    browserProbeSource: source,
    browserProbeOutput: output,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const fixture = await fetch(`${origin}/fixtures/browser-probe.pptx`);
    assert.equal(fixture.status, 200);
    assert.deepEqual(Buffer.from(await fixture.arrayBuffer()), sourceBytes);
    const bridge = await fetch(
      `${origin}/extensions/org.spellbook.editor/browser-probe.html`,
    );
    assert.equal(bridge.status, 200);
    assert.match(await bridge.text(), /probeHistory/u);

    const saved = await fetch(`${origin}/browser-probe/save`, {
      method: "POST",
      body: savedBytes,
    });
    assert.equal(saved.status, 201);
    assert.deepEqual(await saved.json(), { bytes: savedBytes.byteLength });
    assert.deepEqual(await readFile(output), savedBytes);

    const duplicate = await fetch(`${origin}/browser-probe/save`, {
      method: "POST",
      body: savedBytes,
    });
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), {
      error: "browser_probe_output_exists",
    });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});
