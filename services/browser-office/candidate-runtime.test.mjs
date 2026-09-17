import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { admitCandidateRuntime } from "./candidate-runtime.mjs";
import { createBrowserRuntimeReceipt } from "./libreoffice/write-build-receipt.mjs";

const packageMetadata = JSON.stringify({
  remote_package_size: 1,
  files: ["scalc", "swriter", "simpress", "sdraw"].map((module) => ({
    filename: `/instdir/share/config/soffice.cfg/modules/${module}/menubar/menubar.xml`,
    start: 0,
    end: 1,
  })),
});
const packageJavascript = ["scalc", "swriter", "simpress", "sdraw"]
  .map(
    (module) =>
      `Module["FS_createPath"]("/instdir/share/config/soffice.cfg/modules/${module}","menubar",true,true);`,
  )
  .join("\n");

test("candidate runtime serves only receipt-bound production assets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spellbook-candidate-"));
  try {
    await writeArtifacts(root);
    const receipt = await createBrowserRuntimeReceipt({
      runtimeDirectory: root,
      repositoryRoot: path.resolve(import.meta.dirname, "../.."),
      sourceRevision: "a".repeat(40),
      builtAt: "2026-09-15T00:00:00.000Z",
      platform: "test-platform",
    });
    await writeFile(
      path.join(root, "build-receipt.json"),
      `${JSON.stringify(receipt)}\n`,
    );

    const admitted = await admitCandidateRuntime({ runtimeDirectory: root });
    assert.equal(admitted.runtimeIdentity.buildReady, true);
    assert.match(admitted.receiptSha256, /^[0-9a-f]{64}$/u);
    assert.equal(
      admitted.runtimeIdentity.buildCommit,
      admitted.runtimeIdentity.candidateCommit,
    );
    assert.deepEqual(
      admitted.upstream.runtimeAssets.map(({ storedPath }) => storedPath),
      [
        "soffice.js",
        "soffice.data.js.metadata",
        "soffice.wasm.br",
        "soffice.data.br",
      ],
    );
    assert.deepEqual(
      admitted.upstream.runtimeAssets.map(
        ({ contentEncoding }) => contentEncoding ?? "identity",
      ),
      ["identity", "identity", "br", "br"],
    );

    const staleJavascript = packageJavascript.replace(
      /^.*modules\/sdraw.*(?:\n|$)/mu,
      "",
    );
    await writeFile(path.join(root, "soffice.js"), staleJavascript);
    const staleReceipt = structuredClone(receipt);
    const scriptArtifact = staleReceipt.artifacts.find(
      ({ name }) => name === "soffice.js",
    );
    scriptArtifact.bytes = Buffer.byteLength(staleJavascript);
    scriptArtifact.sha256 = createHash("sha256")
      .update(staleJavascript)
      .digest("hex");
    await writeFile(
      path.join(root, "build-receipt.json"),
      `${JSON.stringify(staleReceipt)}\n`,
    );
    await assert.rejects(
      admitCandidateRuntime({ runtimeDirectory: root }),
      /JavaScript filesystem disagree.*sdraw/u,
    );
    await writeFile(path.join(root, "soffice.js"), packageJavascript);
    await writeFile(
      path.join(root, "build-receipt.json"),
      `${JSON.stringify(receipt)}\n`,
    );

    await writeFile(path.join(root, "soffice.data"), Buffer.from([0x02]));
    await assert.rejects(
      admitCandidateRuntime({ runtimeDirectory: root }),
      /digest differs/u,
    );
    await writeFile(path.join(root, "soffice.data"), Buffer.from([0x01]));
    await writeFile(path.join(root, "soffice.data.br"), Buffer.from([0x04]));
    await assert.rejects(
      admitCandidateRuntime({ runtimeDirectory: root }),
      /digest differs/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeArtifacts(root) {
  await Promise.all([
    writeFile(path.join(root, "soffice.js"), packageJavascript),
    writeFile(path.join(root, "soffice.data.js.metadata"), packageMetadata),
    writeFile(
      path.join(root, "soffice.wasm"),
      Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01]),
    ),
    writeFile(path.join(root, "soffice.data"), Buffer.from([0x01])),
    writeFile(path.join(root, "soffice.wasm.br"), Buffer.from([0x02])),
    writeFile(path.join(root, "soffice.data.br"), Buffer.from([0x03])),
  ]);
}
