/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildOnlyOfficeComparisonPlan,
  summarizeOnlyOfficeBatch,
} from "./onlyoffice/comparison-plan.mjs";
const capabilities = JSON.parse(
  readFileSync(
    new URL("../../contracts/native-edit-capabilities.json", import.meta.url),
  ),
);
const conformance = JSON.parse(
  readFileSync(
    new URL(
      "../../contracts/native-mutation-conformance.json",
      import.meta.url,
    ),
  ),
);
const plan = buildOnlyOfficeComparisonPlan(capabilities, conformance, [
  "shape-fill",
]);
function row(mode) {
  return {
    caseId: "shape-fill",
    mode,
    exitCode: 0,
    sameBuild: true,
    report: {
      sourceStable: true,
      candidateCodeStable: true,
      candidateDistributionStable: true,
      inputFontCoverage: { valid: true },
      inputSha256: plan.cases[0].sourceSha256,
      cases: [
        {
          typedCase: "shape-fill",
          status:
            mode === "normal"
              ? "typed-apply-save-history-reopen-verified"
              : "typed-failed-mutation-rollback-verified",
          rollbackVerified: true,
          expectedFailure: true,
          preexistingRedo: { replayedAndUndone: true },
        },
      ],
    },
  };
}
test("candidate diagnostics derive the entire product denominator and fixtures from canonical contracts", () => {
  const full = buildOnlyOfficeComparisonPlan(capabilities, conformance);
  assert.equal(full.expectedOperations.length, 94);
  assert.equal(full.trials.length, full.cases.length * 3);
  assert.equal(
    full.cases.find((value) => value.id === "table-row-add").source,
    conformance.scenarios["table-structure"].source,
  );
  assert.deepEqual(
    full.cases.find((value) => value.id === "wordart-insert").relatedOperations,
    [],
  );
  assert.ok(full.operationsWithoutRelatedDiagnostic.includes("set_fontwork"));
  assert.equal(full.admissionStatus, "not_admitted");
  const newer = structuredClone(capabilities);
  newer.mutationModel.operations.new_text_operation = {
    ...newer.mutationModel.operations.font_size,
  };
  assert.ok(
    buildOnlyOfficeComparisonPlan(
      newer,
      conformance,
    ).operationsWithoutRelatedDiagnostic.includes("new_text_operation"),
  );
});
test("unknown cases, duplicate selection and removed contract operations cannot silently shrink the batch", () => {
  assert.throws(
    () => buildOnlyOfficeComparisonPlan(capabilities, conformance, ["unknown"]),
    /Unknown/,
  );
  assert.throws(
    () =>
      buildOnlyOfficeComparisonPlan(capabilities, conformance, [
        "shape-fill",
        "shape-fill",
      ]),
    /Distinct/,
  );
  const changed = structuredClone(capabilities);
  delete changed.mutationModel.operations.set_shape_fill;
  assert.throws(
    () => buildOnlyOfficeComparisonPlan(changed, conformance, ["shape-fill"]),
    /missing product operation/,
  );
});
test("all three native outcomes can complete diagnostics but never admit the product engine", () => {
  const result = summarizeOnlyOfficeBatch(plan, [
    row("normal"),
    row("rollback"),
    row("rollback-redo"),
  ]);
  assert.equal(result.completeWithinSelectedDiagnostics, true);
  assert.equal(result.admissionStatus, "not_admitted");
  assert.equal(result.productOperations, 94);
});
for (const failure of [
  "missing",
  "duplicate",
  "unknown",
  "process",
  "source",
  "distribution",
  "mixed-build",
  "font",
  "fixture",
  "rollback",
  "redo",
])
  test("refuses " + failure + " trial evidence", () => {
    const rows = [row("normal"), row("rollback"), row("rollback-redo")];
    if (failure === "missing") rows.pop();
    if (failure === "duplicate") rows.push(row("normal"));
    if (failure === "unknown")
      rows.push({ ...row("normal"), caseId: "unknown" });
    if (failure === "process") rows[0].exitCode = 1;
    if (failure === "mixed-build") rows[0].sameBuild = false;
    if (failure === "source") rows[0].report.sourceStable = false;
    if (failure === "distribution")
      rows[0].report.candidateDistributionStable = false;
    if (failure === "font") rows[0].report.inputFontCoverage.valid = false;
    if (failure === "fixture") rows[0].report.inputSha256 = "0".repeat(64);
    if (failure === "rollback")
      rows[1].report.cases[0].rollbackVerified = false;
    if (failure === "redo")
      rows[2].report.cases[0].preexistingRedo.replayedAndUndone = false;
    assert.equal(
      summarizeOnlyOfficeBatch(plan, rows).completeWithinSelectedDiagnostics,
      false,
    );
  });
