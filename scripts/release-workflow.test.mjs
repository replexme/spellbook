import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/release.yml", "utf8");

test("tag releases verify the exact source before publishing", () => {
  assert.match(workflow, /tags:\s*\n\s*- "v\*"/);
  assert.match(workflow, /pnpm verify/);
  assert.match(workflow, /reuse lint/);
  assert.match(workflow, /--source-version "\$GITHUB_SHA"/);
  assert.match(workflow, /verify-release-sbom\.mjs/);
  assert.match(workflow, /needs: \[verify-source, runtime-sboms\]/);
});

test("release SBOMs cover the source and every shipped runtime image", () => {
  for (const name of [
    "web",
    "ai-connector",
    "document-worker",
    "document-view",
  ]) {
    assert.match(workflow, new RegExp(`name: ${name}`));
  }
  for (const name of ["office-editor", "browser-office"])
    assert.doesNotMatch(workflow, new RegExp(`name: ${name}`));
  assert.match(workflow, /spellbook-source-\$\{GITHUB_SHA\}\.spdx\.json/);
  assert.match(
    workflow,
    /spellbook-\$\{\{ matrix\.name \}\}-\$\{GITHUB_SHA\}\.spdx\.json/,
  );
  assert.match(workflow, /syft-version: v1\.51\.1/);
  assert.match(
    workflow,
    /anchore\/sbom-action\/download-syft@006b7ce8314066bdf1765b4500370d40fa6917a3/,
  );
});

test("publication attaches checksummed SBOMs to the immutable tag", () => {
  assert.match(workflow, /SHA256SUMS/);
  assert.match(workflow, /gh release create "\$tag"/);
  assert.match(workflow, /--verify-tag/);
  assert.match(workflow, /gh release upload "\$tag"/);
  assert.match(workflow, /--clobber/);
});
