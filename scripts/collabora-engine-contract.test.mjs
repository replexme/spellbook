import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  compareCollaboraRefs,
  computePatchSeriesSha256,
  latestCollaboraRef,
  upstreamManifest,
  valueAtPath,
} from "../services/office-editor/libreoffice/upstream.mjs";

test("browser engine source, patches and runtime are locked in one manifest", () => {
  assert.equal(valueAtPath("source.ref"), upstreamManifest.source.ref);
  assert.match(upstreamManifest.source.commit, /^[0-9a-f]{40}$/u);
  assert.match(upstreamManifest.runtimeImage, /@sha256:[0-9a-f]{64}$/u);
  assert.match(upstreamManifest.runtimePatchLevel, /^(?:stock|undo-v\d+)$/u);
  assert.match(upstreamManifest.patchSeriesSha256, /^[0-9a-f]{64}$/u);
  assert.equal(
    new Set(upstreamManifest.patches).size,
    upstreamManifest.patches.length,
  );
  assert.ok(
    upstreamManifest.patches.every((relativePatch) =>
      existsSync(
        path.resolve("services/office-editor/libreoffice", relativePatch),
      ),
    ),
  );
  assert.equal(computePatchSeriesSha256(), upstreamManifest.patchSeriesSha256);
  assert.ok(upstreamManifest.requiredCppunitTargets.length > 0);
  assert.ok(upstreamManifest.focusedCppunitTests.length > 0);
  if (upstreamManifest.sourceCandidateReady) {
    const evidence = upstreamManifest.sourceCandidateEvidence;
    assert.ok(Number.isFinite(Date.parse(evidence.completedAt)));
    assert.match(evidence.spellbookSourceRevision, /^[0-9a-f]{40}$/u);
    assert.equal(
      evidence.patchSeriesSha256,
      upstreamManifest.patchSeriesSha256,
    );
    assert.match(evidence.engineImageDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.doesNotMatch(evidence.engineImageDigest, /[/@]/u);
    assert.match(evidence.nativeEvidenceSha256, /^[0-9a-f]{64}$/u);
    assert.match(evidence.buildResultSha256, /^[0-9a-f]{64}$/u);
    assert.match(evidence.impressCommandReportSha256, /^[0-9a-f]{64}$/u);
    assert.deepEqual(
      Object.keys(evidence.requiredCppunitStatuses).sort(),
      upstreamManifest.requiredCppunitTargets.slice().sort(),
    );
    assert.ok(
      Object.values(evidence.requiredCppunitStatuses).every(
        (status) => status === 0,
      ),
    );
    assert.deepEqual(evidence.impressCommandSurface, {
      count: upstreamManifest.impressUiUnoCommandCount,
      sha256: upstreamManifest.impressUiUnoCommandsSha256,
      exact: true,
    });
  }
});

test("runtime environment is generated only from a digest-pinned manifest", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "spellbook-engine-env-"));
  try {
    const output = path.join(root, "runtime.env");
    execFileSync(process.execPath, [
      "services/office-editor/libreoffice/write-runtime-build-env.mjs",
      output,
    ]);
    const environment = readFileSync(output, "utf8");
    assert.match(
      environment,
      /COLLABORA_RUNTIME_IMAGE='[^']+@sha256:[0-9a-f]{64}'/u,
    );
    assert.match(
      environment,
      /COLLABORA_RUNTIME_PATCH_LEVEL='(?:stock|undo-v\d+)'/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("engine admission and build fetch the immutable source commit", () => {
  for (const script of [
    "services/office-editor/libreoffice/build-engine.sh",
    "services/office-editor/libreoffice/verify-patch.sh",
  ]) {
    const source = readFileSync(script, "utf8");
    assert.match(source, /fetch --quiet --depth=1 origin "\$source_commit"/u);
    assert.match(source, /checkout --quiet --detach FETCH_HEAD/u);
    assert.doesNotMatch(source, /clone .*--branch "\$source_ref"/u);
  }
});

test("engine admission and release build require complete semantic command routing", () => {
  for (const script of [
    "services/office-editor/libreoffice/build-engine.sh",
    "services/office-editor/libreoffice/verify-patch.sh",
  ]) {
    const source = readFileSync(script, "utf8");
    assert.match(source, /audit-ai-command-surface\.mjs/u, script);
  }
  const verifier = readFileSync(
    "services/office-editor/libreoffice/verify-patch.sh",
    "utf8",
  );
  assert.match(verifier, /semanticRouting\.complete/u);
});

test("Collabora release refs use numeric ordering", () => {
  assert.ok(compareCollaboraRefs("cp-26.04.10-1", "cp-26.04.9-9") > 0);
  assert.equal(
    latestCollaboraRef([
      "cp-26.04.3-2",
      "not-a-release",
      "cp-26.04.10-1",
      "cp-25.04.9-9",
    ]),
    "cp-26.04.10-1",
  );
  assert.throws(() => valueAtPath("source.missing"), /Unknown upstream key/u);
});

test("runtime mutation contracts are generated from the public capability model", () => {
  const capabilities = JSON.parse(
    readFileSync("contracts/native-edit-capabilities.json", "utf8"),
  );
  const conformance = JSON.parse(
    readFileSync("contracts/native-mutation-conformance.json", "utf8"),
  );
  const patchVersion = /^undo-v(?<version>[1-9][0-9]*)$/u.exec(
    upstreamManifest.patchLevel,
  );
  assert.ok(patchVersion?.groups?.version);
  assert.equal(
    conformance.enginePatchLevel,
    Number(patchVersion.groups.version),
  );
  const operations = capabilities.mutationModel.operations;
  assert.equal(Object.keys(operations).length, 98);
  assert.equal(operations.set_printable.availability, "format_excluded");
  assert.ok(
    Object.values(operations)
      .filter((operation) => operation.availability !== "format_excluded")
      .every((operation) =>
        ["runtime_verified", "runtime_validation_required"].includes(
          operation.availability,
        ),
      ),
  );
  assert.equal(operations.insert_slide.minEnginePatch, 9);
  assert.equal(operations.set_object_interaction.minEnginePatch, 18);
  assert.equal(operations.set_object_interaction.family, "object_interaction");
  const exposedOperations = capabilities.toolInputSchema.properties.op.enum;
  assert.equal(exposedOperations.length, 95);
  assert.equal(new Set(exposedOperations).size, exposedOperations.length);
  assert.deepEqual(
    exposedOperations.slice().sort(),
    Object.entries(operations)
      .filter(([, operation]) => operation.availability !== "format_excluded")
      .map(([operation]) => operation)
      .sort(),
  );
  assert.equal(
    capabilities.aiExposure.operationCount,
    exposedOperations.length,
  );
  const operationGroups = capabilities.operationGroups;
  for (const operation of operationGroups.document)
    assert.ok(["document", "master"].includes(operations[operation].target));
  for (const operation of operationGroups.slide)
    assert.equal(operations[operation].target, "slide");
  for (const operation of operationGroups.create) {
    assert.equal(operations[operation].target, "slide");
    assert.equal(operations[operation].family, "object_creation");
  }
  for (const operation of operationGroups.multiElement)
    assert.equal(operations[operation].target, "elements");
  for (const operation of operationGroups.element)
    assert.ok(
      ["element", "table_cell", "table_range", "animation_effect"].includes(
        operations[operation].target,
      ),
    );
  const generated = readFileSync(
    "services/office-editor/extension/mutation-contract.generated.js",
    "utf8",
  );
  for (const operation of Object.keys(operations))
    assert.match(generated, new RegExp(`"${operation}"`, "u"));
});

test("the checked-in native conformance fixture is reproducible", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "spellbook-fixture-"));
  try {
    const generated = path.join(root, "general-native-surface.pptx");
    execFileSync("python3", [
      "scripts/generate-native-conformance-fixture.py",
      generated,
    ]);
    assert.deepEqual(
      readFileSync(generated),
      readFileSync("eval/public/fixtures/general-native-surface.pptx"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime limitations name every operation a runtime cannot execute", () => {
  const capabilities = JSON.parse(
    readFileSync("contracts/native-edit-capabilities.json", "utf8"),
  );
  const operations = capabilities.mutationModel.operations;
  const marked = Object.entries(operations).flatMap(([operation, contract]) =>
    (contract.unavailableIn ?? []).map((runtime) => `${runtime}:${operation}`),
  );
  const explained = Object.entries(capabilities.runtimeLimitations).flatMap(
    ([runtime, limitations]) =>
      limitations.map(({ op, reason }) => {
        assert.ok(operations[op], `${op} is not a contract operation`);
        assert.notEqual(operations[op].availability, "format_excluded");
        assert.ok(reason.length > 40, `${runtime}:${op} needs a reason`);
        return `${runtime}:${op}`;
      }),
  );
  assert.deepEqual(marked.sort(), explained.sort());
});
