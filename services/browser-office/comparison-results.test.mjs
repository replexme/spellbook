/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  summarizeEngineComparison,
  comparisonFormatStatus,
} from "./comparison-results.mjs";

const fixture = () => ({
  inputs: [{ label: "deck", scenarios: ["type", "move"] }],
  engines: ["native", "onlyoffice"],
  preserveSource: true,
  repairStructure: true,
  sourceStable: true,
  cases: ["native", "onlyoffice"].flatMap((engine) =>
    ["type", "move"].map((scenario) => ({
      label: "deck",
      engine,
      scenario,
      engineProcessCode: 0,
      ...(engine === "native"
        ? { outcome: "saved" }
        : { status: "source-preserved-save-reopen-verified" }),
      savedOpenXml: { Valid: true },
      sourcePreservation: { valid: true },
    })),
  ),
});
test("paired comparison completes only the requested scenario scope", () => {
  const result = summarizeEngineComparison(fixture());
  assert.equal(result.completeWithinRequestedScenarios, true);
  assert.equal(result.expectedCases, 4);
  assert.equal(result.verifiedCases, 4);
  assert.equal(result.onlyofficeSourcePreservedVerified, 2);
  assert.equal(result.nativeSaved, 2);
  assert.match(result.proofScope, /excludes the complete product/);
});
for (const mode of [
  "missing",
  "duplicate",
  "unknown",
  "raw",
  "invalid",
  "unverified",
  "process",
  "refused",
  "note",
  "missing-process",
  "unstable-source",
  "missing-source",
  "empty-matrix",
  "missing-preservation",
  "collateral-preservation",
]) {
  test(`paired comparison refuses ${mode} results`, () => {
    const value = fixture();
    if (mode === "missing") value.cases.pop();
    if (mode === "duplicate") value.cases.push({ ...value.cases[0] });
    if (mode === "unknown")
      value.cases.push({ ...value.cases[0], scenario: "unknown" });
    if (mode === "raw") value.cases[2].status = "raw-export-reopen-verified";
    if (mode === "invalid") value.cases[2].savedOpenXml.Valid = false;
    if (mode === "unverified") delete value.cases[2].savedOpenXml;
    if (mode === "process") value.cases[2].engineProcessCode = 1;
    if (mode === "refused") value.cases[0].outcome = "refused";
    if (mode === "note") value.cases[0].note = "Not a saved intent proof";
    if (mode === "missing-process") delete value.cases[2].engineProcessCode;
    if (mode === "missing-preservation")
      delete value.cases[2].sourcePreservation;
    if (mode === "collateral-preservation")
      value.cases[2].sourcePreservation.valid = false;
    if (mode === "unstable-source") value.sourceStable = false;
    if (mode === "missing-source") delete value.sourceStable;
    if (mode === "empty-matrix") {
      value.inputs = [];
      value.cases = [];
    }
    const result = summarizeEngineComparison(value);
    assert.equal(result.completeWithinRequestedScenarios, false);
    assert.ok(result.failures.length > 0);
  });
}
test("raw and repaired diagnostics remain explicit and cannot satisfy preserved-save comparison", () => {
  for (const repairStructure of [false, true]) {
    const value = fixture();
    value.preserveSource = false;
    value.repairStructure = repairStructure;
    for (const row of value.cases.filter((row) => row.engine === "onlyoffice"))
      row.status = repairStructure
        ? "repaired-export-reopen-verified"
        : "raw-export-reopen-verified";
    assert.equal(
      summarizeEngineComparison(value).completeWithinRequestedScenarios,
      true,
    );
    value.preserveSource = true;
    assert.equal(
      summarizeEngineComparison(value).completeWithinRequestedScenarios,
      false,
    );
  }
});

test("original format errors are retained explicitly only with preserved scope and exact error provenance", () => {
  const value = fixture(),
    cell = value.cases[0];
  cell.originalOpenXml = {
    Valid: false,
    Errors: ["original chart order"],
    Failure: null,
    ReaderAdjustments: [],
  };
  cell.savedOpenXml = structuredClone(cell.originalOpenXml);
  assert.equal(comparisonFormatStatus(cell), "retained_original_errors");
  const result = summarizeEngineComparison(value);
  assert.equal(result.completeWithinRequestedScenarios, true);
  assert.equal(result.fullyFormatValid, 3);
  assert.equal(result.retainedOriginalFormatErrors, 1);
  for (const change of [
    (c) => {
      c.savedOpenXml.Errors.push("new error");
    },
    (c) => {
      c.savedOpenXml.Failure = "reader failed";
    },
    (c) => {
      c.savedOpenXml.validatorFailed = true;
    },
    (c) => {
      c.savedOpenXml.ReaderAdjustments.push("hidden fix");
    },
    (c) => {
      c.sourcePreservation.valid = false;
    },
  ]) {
    const next = structuredClone(value);
    change(next.cases[0]);
    assert.equal(
      summarizeEngineComparison(next).completeWithinRequestedScenarios,
      false,
    );
  }
});
