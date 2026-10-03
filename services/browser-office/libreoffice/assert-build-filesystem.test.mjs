/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertBuildFilesystem } from "./assert-build-filesystem.mjs";

test("build admission follows actual filesystem case behavior and cleans probes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "spellbook-fs-test-"));
  try {
    writeFileSync(path.join(root, "type.idl"), "source");
    const insensitive = existsSync(path.join(root, "TYPE.IDL"));
    if (insensitive)
      assert.throws(
        () => assertBuildFilesystem(root),
        /case-sensitive filesystem/,
      );
    else assert.doesNotThrow(() => assertBuildFilesystem(root));
    assert.deepEqual(readdirSync(root), ["type.idl"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
