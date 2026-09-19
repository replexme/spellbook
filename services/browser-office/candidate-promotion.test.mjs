import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createCandidatePromotion } from "./candidate-promotion.mjs";
import { upstreamManifest } from "./libreoffice/upstream.mjs";
import { browserRuntimeBuildInputPaths } from "./repository-identity.mjs";
import { buildConformancePlan } from "../../scripts/native-mutation-conformance.mjs";

const operations = [
  "replace_text",
  "move",
  "resize",
  "fill_color",
  "rotate",
  "line_color",
  "line_width",
  "fill_opacity",
  "line_opacity",
  "font_size",
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "font_family",
  "font_color",
  "paragraph_alignment",
];
const capabilities = JSON.parse(
  readFileSync(
    new URL("../../contracts/native-edit-capabilities.json", import.meta.url),
    "utf8",
  ),
);
const conformance = JSON.parse(
  readFileSync(
    new URL(
      "../../contracts/native-mutation-conformance.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const browserPlan = buildConformancePlan(capabilities, conformance, {
  enginePatchLevel: conformance.enginePatchLevel,
  runtime: "browser",
});
const nativeOperations = Object.values(browserPlan.families)
  .flatMap((family) => family.operations)
  .sort();
const receiptSha256 = "a".repeat(64);
const savedSha256 = "b".repeat(64);
const admittedRuntime = {
  receiptSha256,
  receipt: {
    spellbookSourceRevision: "c".repeat(40),
    libreOffice: { patchLevel: upstreamManifest.sourceCandidate.patchLevel },
    toolchain: { emsdk: { version: "3.1.65" } },
    artifacts: [{ name: "soffice.wasm", sha256: "d".repeat(64) }],
  },
};
const runtimeBuildInputEquivalence = {
  buildSourceRevision: "c".repeat(40),
  integrationSourceRevision: "e".repeat(40),
  inputs: browserRuntimeBuildInputPaths.map((path) => ({
    path,
    buildObject: "1".repeat(40),
    integrationObject: "1".repeat(40),
    exact: true,
  })),
  exact: true,
};
const browserReport = {
  status: "browser-product-bridge-verified",
  patchedBrowserRuntime: true,
  candidateRuntime: { receiptSha256 },
  integrationSource: { revision: "e".repeat(40), dirty: false },
  verifiedElementOperations: operations,
  endurance: {
    status: "browser-product-endurance-verified",
    cycles: 100,
    operations,
  },
  changedParts: ["ppt/slides/slide1.xml"],
  nativeSnapshotPersisted: true,
  nativeSnapshotPreserved: true,
  nativeSnapshotChangedParts: ["ppt/slides/slide1.xml"],
  replacement: "Spellbook · product bridge",
  savedSha256,
  postSaveEditRecovered: true,
  pageErrors: [],
  requestFailures: [],
};
const nativeConformanceReport = {
  status: "browser-native-conformance-verified",
  candidateReceiptSha256: receiptSha256,
  integrationSource: { revision: "e".repeat(40), dirty: false },
  expectedOperations: nativeOperations,
  executedOperations: nativeOperations,
  missingOperations: [],
  scenarios: Object.keys(browserPlan.scenarios).map((scenario) => ({
    scenario,
    status: "passed",
    baseline: { sha256: "b".repeat(64), reopened: true },
    candidate: { sha256: "c".repeat(64) },
    mutationReportSha256: "d".repeat(64),
    reopenVerified: true,
    missingSelectedOperations: [],
    changeBudget: { valid: true },
  })),
};
const powerpointReport = {
  valid: true,
  errors: [],
  browserReceiptSha256: receiptSha256,
  nativeConformanceSha256: "1".repeat(64),
  integrationSourceRevision: "e".repeat(40),
  savedSha256,
  renderer: { name: "Microsoft PowerPoint", version: "16.109.1" },
  slideCounts: { source: 1, candidate: 1 },
  visibleEdit: { normalizedRmse: 0.01 },
};

test("promotion receipt binds runtime, browser endurance and PowerPoint", () => {
  const promotion = createCandidatePromotion({
    admittedRuntime,
    integrationSource: browserReport.integrationSource,
    runtimeBuildInputEquivalence,
    browserReport,
    browserReportSha256: "e".repeat(64),
    nativeConformanceReport,
    nativeConformanceReportSha256: "1".repeat(64),
    powerpointReport,
    powerpointReportSha256: "f".repeat(64),
    verifiedAt: "2026-09-15T00:00:00.000Z",
  });
  assert.equal(promotion.status, "verified_not_published");
  assert.equal(promotion.runtime.receiptSha256, receiptSha256);
  assert.equal(promotion.runtime.buildInputEquivalence.exact, true);
  assert.equal(promotion.spellbookSourceRevision, "e".repeat(40));
  assert.equal(promotion.runtime.buildSourceRevision, "c".repeat(40));
  assert.equal(promotion.evidence.enduranceCycles, 100);
  assert.throws(
    () =>
      createCandidatePromotion({
        admittedRuntime,
        integrationSource: browserReport.integrationSource,
        runtimeBuildInputEquivalence,
        browserReport,
        browserReportSha256: "e".repeat(64),
        nativeConformanceReport,
        nativeConformanceReportSha256: "1".repeat(64),
        powerpointReport: { ...powerpointReport, savedSha256: "0".repeat(64) },
        powerpointReportSha256: "f".repeat(64),
      }),
    /browser-saved PPTX/u,
  );
  assert.throws(
    () =>
      createCandidatePromotion({
        admittedRuntime,
        integrationSource: browserReport.integrationSource,
        runtimeBuildInputEquivalence: {
          ...runtimeBuildInputEquivalence,
          exact: false,
        },
        browserReport,
        browserReportSha256: "e".repeat(64),
        nativeConformanceReport,
        nativeConformanceReportSha256: "1".repeat(64),
        powerpointReport,
        powerpointReportSha256: "f".repeat(64),
      }),
    /build inputs differ/u,
  );
  assert.deepEqual(
    promotion.evidence.verifiedNativeOperations,
    nativeOperations,
  );
});
