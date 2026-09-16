import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createBrowserRuntimeReceipt } from "./write-build-receipt.mjs";
import { computePatchSeriesSha256, upstreamManifest } from "./upstream.mjs";

const packageMetadata = JSON.stringify({
  remote_package_size: 1,
  files: ["scalc", "swriter", "simpress", "sdraw"].map((module) => ({
    filename: `/instdir/share/config/soffice.cfg/modules/${module}/menubar/menubar.xml`,
    start: 0,
    end: 1,
  })),
});

test("browser runtime receipt binds every artifact to source and toolchain identity", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "spellbook-browser-receipt-"),
  );
  try {
    await Promise.all([
      writeFile(path.join(root, "soffice.js"), "Module = {};\n"),
      writeFile(path.join(root, "soffice.data.js.metadata"), packageMetadata),
      writeFile(
        path.join(root, "soffice.wasm"),
        Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01]),
      ),
      writeFile(path.join(root, "soffice.data"), Buffer.from([0x01])),
      writeFile(path.join(root, "soffice.wasm.br"), Buffer.from([0x02])),
      writeFile(path.join(root, "soffice.data.br"), Buffer.from([0x03])),
    ]);
    const receipt = await createBrowserRuntimeReceipt({
      runtimeDirectory: root,
      repositoryRoot: path.resolve(import.meta.dirname, "../../.."),
      sourceRevision: "a".repeat(40),
      builtAt: "2026-09-15T00:00:00.000Z",
      platform: "test-platform",
    });
    assert.equal(receipt.status, "built_unverified");
    assert.equal(receipt.schemaVersion, 2);
    assert.deepEqual(
      receipt.wasmModules,
      upstreamManifest.sourceCandidate.wasmModules,
    );
    assert.equal(
      receipt.libreOffice.patchLevel,
      upstreamManifest.sourceCandidate.patchLevel,
    );
    assert.equal(
      receipt.libreOffice.patchSeriesSha256,
      computePatchSeriesSha256(),
    );
    assert.equal(receipt.spellbookSourceRevision, "a".repeat(40));
    assert.deepEqual(
      receipt.artifacts.map(({ name }) => name),
      [
        "soffice.js",
        "soffice.data.js.metadata",
        "soffice.wasm",
        "soffice.data",
        "soffice.wasm.br",
        "soffice.data.br",
      ],
    );
    for (const artifact of receipt.artifacts) {
      assert.ok(artifact.bytes > 0);
      assert.match(artifact.sha256, /^[0-9a-f]{64}$/u);
    }

    await writeFile(
      path.join(root, "soffice.data.js.metadata"),
      JSON.stringify({
        remote_package_size: 1,
        files: JSON.parse(packageMetadata).files.filter(
          ({ filename }) => !filename.includes("/simpress/"),
        ),
      }),
    );
    await assert.rejects(
      createBrowserRuntimeReceipt({
        runtimeDirectory: root,
        repositoryRoot: path.resolve(import.meta.dirname, "../../.."),
        sourceRevision: "a".repeat(40),
      }),
      /missing impress assets/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
