/* SPDX-License-Identifier: MPL-2.0 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  verifyOfficeDistribution,
  readOfficeDistributionEvidence,
} from "./distribution-check.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
test("distribution rejects unreviewed fonts, changed source/code and unlisted files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "office-distribution-"));
  const font = "reviewed OFL font";
  const sources = "source and build scripts";
  const content = {
    "LICENSE-AGPL-3.0.txt": "license",
    "NOTICE.txt": "notice",
    "licensing.html": "notice and source links",
    "sources/BUILD.md": "build commands",
    "sources/editor.tar.gz": sources,
    "fonts/000.ttf": font,
    "editor.js": "compiled editor",
    "onlyoffice-browser-font-assets.json": JSON.stringify({
      fontSet: "redistributable",
      fonts: ["fonts/000.ttf"],
    }),
    "font-licenses.json": JSON.stringify({
      fonts: [
        {
          file: "fonts/000.ttf",
          license: "OFL-1.1",
          notice: "SIL OPEN FONT LICENSE",
          source: "https://example.test/font",
          sha256: digest(font),
        },
      ],
    }),
  };
  async function reset() {
    await rm(root, { recursive: true, force: true });
    await mkdir(root);
    for (const [file, bytes] of Object.entries(content)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), bytes);
    }
    await writeFile(
      path.join(root, "distribution-manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        engine: "onlyoffice",
        sourceMaterialsPackaged: true,
        upstreamEditorRebuildVerified: false,
        sources: [
          {
            id: "editor",
            archive: "editor.tar.gz",
            archiveSha256: digest(sources),
          },
        ],
        files: Object.entries(content).map(([file, bytes]) => ({
          path: file,
          sha256: digest(bytes),
        })),
      }),
    );
  }
  try {
    await reset();
    const original = await readOfficeDistributionEvidence(root);
    assert.equal(original.valid, true);
    assert.match(original.distributionSha256, /^[a-f0-9]{64}$/u);
    assert.equal(
      (await verifyOfficeDistribution(root)).upstreamEditorRebuildVerified,
      false,
    );
    for (const file of [
      "fonts/000.ttf",
      "sources/editor.tar.gz",
      "editor.js",
    ]) {
      await reset();
      await writeFile(path.join(root, file), "replaced bytes");
      await assert.rejects(verifyOfficeDistribution(root), /hash mismatch/);
      const failed = await readOfficeDistributionEvidence(root);
      assert.equal(failed.valid, false);
      assert.match(failed.error, /hash mismatch/);
    }
    // A second reviewed font package can be valid in isolation while changing
    // rendering and invalidating an earlier trial's distribution identity.
    content["fonts/000.ttf"] = "another reviewed OFL font";
    const permissions = JSON.parse(content["font-licenses.json"]);
    permissions.fonts[0].sha256 = digest(content["fonts/000.ttf"]);
    content["font-licenses.json"] = JSON.stringify(permissions);
    await reset();
    const replacement = await readOfficeDistributionEvidence(root);
    assert.equal(replacement.valid, true);
    assert.notEqual(
      replacement.distributionSha256,
      original.distributionSha256,
    );
    await reset();
    await writeFile(path.join(root, "fonts/unlicensed.ttf"), "unreviewed font");
    await assert.rejects(
      verifyOfficeDistribution(root),
      /Unlisted distribution file/,
    );
    await rm(path.join(root, "distribution-manifest.json"));
    assert.equal((await readOfficeDistributionEvidence(root)).valid, false);
    content["onlyoffice-browser-font-assets.json"] = JSON.stringify({
      fontSet: "full",
      fonts: ["fonts/000.ttf"],
    });
    await reset();
    await assert.rejects(
      verifyOfficeDistribution(root),
      /not reviewed redistributable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
