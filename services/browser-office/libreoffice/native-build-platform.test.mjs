/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("the actual native build guard accepts pinned Linux hosts and refuses other platforms", () => {
  const source = readFileSync(new URL("./build-candidate-runtime.sh", import.meta.url), "utf8");
  const end = source.indexOf('if [[ "$EUID" -eq 0 ]]');
  assert(end > 0, "Platform guard must precede resource creation");
  const root = mkdtempSync(path.join(tmpdir(), "office-platform-"));
  try {
    writeFileSync(path.join(root, "uname"), '#!/bin/sh\ncase "$1" in -s) printf "%s\\n" "$OFFICE_TEST_OS";; -m) printf "%s\\n" "$OFFICE_TEST_CPU";; *) exit 2;; esac\n', { mode: 0o755 });
    for (const [os, cpu, accepted] of [
      ["Linux", "x86_64", true],
      ["Linux", "aarch64", true],
      ["Linux", "riscv64", false],
      ["Darwin", "arm64", false],
      ["Windows", "x86_64", false],
    ]) {
      const result = spawnSync("/bin/bash", ["-c", source.slice(0, end)], {
        env: { ...process.env, PATH: root + ":" + process.env.PATH, OFFICE_TEST_OS: os, OFFICE_TEST_CPU: cpu },
        encoding: "utf8",
      });
      assert.equal(result.status === 0, accepted, `${os}/${cpu}: ${result.stderr}`);
      if (!accepted) assert.match(result.stderr, /requires Linux|toolchain requires Linux/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
