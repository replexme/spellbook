import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  browserRuntimeBuildInputPaths,
  readRepositoryPathEquivalence,
} from "./repository-identity.mjs";

test("browser build identity covers the manifest but not non-build documentation", () => {
  assert.ok(
    browserRuntimeBuildInputPaths.includes(
      "services/browser-office/upstream.json",
    ),
  );
  assert.ok(
    browserRuntimeBuildInputPaths.includes(
      "services/browser-office/libreoffice/patches",
    ),
  );
  assert.ok(
    browserRuntimeBuildInputPaths.includes(
      "services/browser-office/libreoffice/verify-linked-filesystem.mjs",
    ),
  );
  assert.equal(
    browserRuntimeBuildInputPaths.some((path) => path.endsWith("README.md")),
    false,
  );
  assert.equal(
    browserRuntimeBuildInputPaths.includes(
      "services/browser-office/libreoffice",
    ),
    false,
  );
});

test("runtime input equivalence permits unrelated commits and rejects input drift", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "spellbook-source-proof-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "--quiet");
    git("config", "user.name", "Spellbook Test");
    git("config", "user.email", "test@invalid.example");
    mkdirSync(path.join(root, "runtime"));
    writeFileSync(path.join(root, "runtime", "input.txt"), "stable\n");
    writeFileSync(path.join(root, "unrelated.txt"), "one\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "build source");
    const buildRevision = git("rev-parse", "HEAD");

    writeFileSync(path.join(root, "unrelated.txt"), "two\n");
    git("commit", "--quiet", "-am", "unrelated change");
    const integrationRevision = git("rev-parse", "HEAD");
    const equivalent = readRepositoryPathEquivalence(
      root,
      buildRevision,
      integrationRevision,
      ["runtime"],
    );
    assert.equal(equivalent.exact, true);
    assert.equal(
      equivalent.inputs[0].buildObject,
      equivalent.inputs[0].integrationObject,
    );

    writeFileSync(path.join(root, "runtime", "input.txt"), "changed\n");
    git("commit", "--quiet", "-am", "runtime input change");
    const driftedRevision = git("rev-parse", "HEAD");
    const drifted = readRepositoryPathEquivalence(
      root,
      buildRevision,
      driftedRevision,
      ["runtime"],
    );
    assert.equal(drifted.exact, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
