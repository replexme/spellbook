import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { captureNativeSnapshots } from "./probe-raw-snapshots.mjs";

test("native probe captures all available raw phases under one scenario", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "spellbook-raw-probe-"),
  );
  const previous = process.env.SPELLBOOK_DIAGNOSTIC_RAW_DIR;
  process.env.SPELLBOOK_DIAGNOSTIC_RAW_DIR = directory;
  try {
    const page = {
      evaluate: async (_callback, label) =>
        label === "native-snapshot-edited" ? null : [0, 1, 2],
    };
    await captureNativeSnapshots(page, "table-style");
    assert.deepEqual(
      await readFile(
        path.join(directory, "table-style", "native-snapshot-original.pptx"),
      ),
      Buffer.from([0, 1, 2]),
    );
    assert.deepEqual(
      await readFile(
        path.join(directory, "table-style", "native-snapshot-no-edit.pptx"),
      ),
      Buffer.from([0, 1, 2]),
    );
    await assert.rejects(
      readFile(
        path.join(directory, "table-style", "native-snapshot-edited.pptx"),
      ),
      /ENOENT/u,
    );
    await assert.deepEqual(
      await readFile(
        path.join(directory, "table-style", "native-snapshot-preserved.pptx"),
      ),
      Buffer.from([0, 1, 2]),
    );
    await assert.rejects(
      captureNativeSnapshots(page, "../outside"),
      /scope is invalid/u,
    );
  } finally {
    if (previous === undefined) delete process.env.SPELLBOOK_DIAGNOSTIC_RAW_DIR;
    else process.env.SPELLBOOK_DIAGNOSTIC_RAW_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
