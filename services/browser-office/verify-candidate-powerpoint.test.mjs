import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildConformancePlan } from "../../scripts/native-mutation-conformance.mjs";
import {
  candidateBrowserReportErrors,
  candidateNativeConformanceErrors,
} from "./verify-candidate-powerpoint.mjs";

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

test("PowerPoint admission requires the complete receipt-bound endurance report", () => {
  const report = {
    status: "browser-product-bridge-verified",
    patchedBrowserRuntime: true,
    candidateRuntime: { receiptSha256: "a".repeat(64) },
    integrationSource: { revision: "c".repeat(40), dirty: false },
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
    savedSha256: "b".repeat(64),
    postSaveEditRecovered: true,
    pageErrors: [],
    requestFailures: [],
  };
  assert.deepEqual(candidateBrowserReportErrors(report), []);
  assert.match(
    candidateBrowserReportErrors({
      ...report,
      postSaveEditRecovered: false,
    }).join("; "),
    /edit made during save/u,
  );
  assert.match(
    candidateBrowserReportErrors({
      ...report,
      endurance: { ...report.endurance, cycles: 99 },
    }).join("; "),
    /100 cycles/u,
  );
  assert.match(
    candidateBrowserReportErrors({
      ...report,
      verifiedElementOperations: operations.slice(1),
    }).join("; "),
    /17-operation bridge/u,
  );
  assert.match(
    candidateBrowserReportErrors({
      ...report,
      nativeSnapshotChangedParts: [
        "ppt/slides/slide1.xml",
        "ppt/slideMasters/slideMaster1.xml",
      ],
    }).join("; "),
    /unrelated original PPTX parts/u,
  );
});

test("PowerPoint admission also requires every typed native operation", () => {
  const scenarios = Object.keys(browserPlan.scenarios).map((scenario) => ({
    scenario,
    status: "passed",
    baseline: { sha256: "b".repeat(64), reopened: true },
    candidate: { sha256: "c".repeat(64) },
    mutationReportSha256: "d".repeat(64),
    reopenVerified: true,
    missingSelectedOperations: [],
    changeBudget: { valid: true },
  }));
  const report = {
    status: "browser-native-conformance-verified",
    candidateReceiptSha256: "a".repeat(64),
    integrationSource: { revision: "c".repeat(40), dirty: false },
    expectedOperations: nativeOperations,
    executedOperations: nativeOperations,
    missingOperations: [],
    scenarios,
  };
  assert.deepEqual(candidateNativeConformanceErrors(report), []);
  assert.match(
    candidateNativeConformanceErrors({
      ...report,
      scenarios: scenarios.map(
        ({ baseline: _baseline, ...scenario }) => scenario,
      ),
    }).join("; "),
    /browser native scenario is incomplete/u,
  );
  assert.match(
    candidateNativeConformanceErrors({
      ...report,
      executedOperations: nativeOperations.slice(1),
    }).join("; "),
    /complete native operation contract/u,
  );
  assert.match(
    candidateNativeConformanceErrors({
      ...report,
      scenarios: scenarios.slice(1),
    }).join("; "),
    /all 12 contract scenarios/u,
  );
});
