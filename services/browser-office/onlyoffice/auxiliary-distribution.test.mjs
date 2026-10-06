/* SPDX-License-Identifier: MPL-2.0 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { verifyOfficeDistribution } from "../distribution-check.mjs";

test("auxiliary rebuild admission binds the provided source and every reproduced module pair", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "auxiliary-distribution-"),
  );
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const files = {
    "LICENSE-AGPL-3.0.txt": "license",
    "NOTICE.txt": "notice",
    "licensing.html": "source links",
    "sources/BUILD.md": "recipe",
    "sources/auxiliary-preferred-source.tar.gz": "preferred source inputs",
    "onlyoffice-browser-font-assets.json": JSON.stringify({
      fontSet: "redistributable",
      fonts: [],
    }),
    "font-licenses.json": JSON.stringify({ fonts: [] }),
  };
  const modules = {
    zlib: "sdkjs/common/zlib/engine/zlib",
    spell: "sdkjs/common/spell/spell/spell",
    hash: "sdkjs/common/hash/hash/engine",
    font: "sdkjs/common/libfont/engine/fonts",
  };
  const receipt = {
    schemaVersion: 1,
    cleanRebuildVerified: true,
    reproductionStatus: "exact-reproduction-verified",
    sourceArchive: "auxiliary-preferred-source.tar.gz",
    sourceArchiveSha256: hash(
      files["sources/auxiliary-preferred-source.tar.gz"],
    ),
    compilerImage: "emscripten/emsdk@sha256:" + "a".repeat(64),
    platform: "linux/amd64",
    outputs: Object.entries(modules).flatMap(([module, base]) =>
      ["js", "wasm"].map((ext) => {
        const name = base + "." + ext;
        files[name] = "built " + name;
        return { module, path: name, sha256: hash(files[name]) };
      }),
    ),
  };
  files["sources/auxiliary-reproduction.json"] = JSON.stringify({
    status: receipt.reproductionStatus,
    sourceArchiveSha256: receipt.sourceArchiveSha256,
    compilerImage: receipt.compilerImage,
    platform: receipt.platform,
    outputs: receipt.outputs.map((row) => ({ ...row, reproduced: true })),
  });
  receipt.reproductionReport = "auxiliary-reproduction.json";
  receipt.reproductionReportSha256 = hash(
    files["sources/auxiliary-reproduction.json"],
  );
  async function write(candidate = receipt, sources = null) {
    files["sources/auxiliary-build-receipt.json"] = JSON.stringify(candidate);
    for (const [name, bytes] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await fs.writeFile(path.join(root, name), bytes);
    }
    await fs.writeFile(
      path.join(root, "distribution-manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        engine: "onlyoffice",
        sourceMaterialsPackaged: true,
        auxiliaryWasmRebuildVerified: true,
        sources: sources ?? [
          {
            id: "onlyoffice-auxiliary",
            archive: receipt.sourceArchive,
            archiveSha256: receipt.sourceArchiveSha256,
          },
        ],
        files: Object.entries(files).map(([name, bytes]) => ({
          path: name,
          sha256: hash(bytes),
        })),
      }),
    );
  }
  try {
    await write();
    assert.equal(
      (await verifyOfficeDistribution(root)).auxiliaryWasmRebuildVerified,
      true,
    );
    await write({ ...receipt, cleanRebuildVerified: false });
    await assert.rejects(
      verifyOfficeDistribution(root),
      /evidence is incomplete/,
    );
    await write({ ...receipt, reproductionReportSha256: "d".repeat(64) });
    await assert.rejects(
      verifyOfficeDistribution(root),
      /report is missing or changed/,
    );
    await write({ ...receipt, reproductionStatus: "failed" });
    await assert.rejects(
      verifyOfficeDistribution(root),
      /evidence is incomplete/,
    );
    await write({ ...receipt, compilerImage: "emscripten/emsdk:latest" });
    await assert.rejects(
      verifyOfficeDistribution(root),
      /evidence is incomplete/,
    );
    await write({ ...receipt, sourceArchiveSha256: "b".repeat(64) });
    await assert.rejects(
      verifyOfficeDistribution(root),
      /evidence is incomplete/,
    );
    await write({ ...receipt, outputs: receipt.outputs.slice(1) });
    await assert.rejects(
      verifyOfficeDistribution(root),
      /all four JS\/WASM pairs/,
    );
    await write({
      ...receipt,
      outputs: receipt.outputs.map((row, i) =>
        i ? row : { ...row, sha256: "c".repeat(64) },
      ),
    });
    await assert.rejects(
      verifyOfficeDistribution(root),
      /output identity mismatch/,
    );
    await write(receipt, [
      {
        id: "different-source",
        archive: receipt.sourceArchive,
        archiveSha256: receipt.sourceArchiveSha256,
      },
    ]);
    await assert.rejects(
      verifyOfficeDistribution(root),
      /evidence is incomplete/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
