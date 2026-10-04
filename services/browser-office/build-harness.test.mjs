import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareHarness } from "./build-harness.mjs";

test("explicit existing-worker verification never builds missing, unbound or mismatching artifacts", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "office-existing-worker-"),
  );
  const bytes = Buffer.from("existing worker bytes"),
    digest = createHash("sha256").update(bytes).digest("hex");
  const run = (sha) =>
    prepareHarness({
      argv: ["node", "verify", "--existing-harness-worker-sha256", sha],
      runtimeDirectory: directory,
    });
  try {
    await assert.rejects(run(undefined), /explicit SHA-256/);
    await assert.rejects(run(digest), /ENOENT/);
    await writeFile(path.join(directory, "ooxml-worker.js"), bytes);
    await assert.rejects(run("0".repeat(64)), /hash differs/);
    const evidence = await run(digest);
    assert.equal(evidence.newBuilds, 0);
    assert.equal(evidence.sha256, digest);
    assert.equal(evidence.bytes, bytes.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
