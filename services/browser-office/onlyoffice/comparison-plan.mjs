/* SPDX-License-Identifier: MPL-2.0 */
import { buildConformancePlan } from "../../../scripts/native-mutation-conformance.mjs";

// This catalog links diagnostic SDK trials to the product vocabulary. Related
// operations are investigation pointers, never claims of product admission.
const definitions = [
  ["table-row-add", "table-structure", ["insert_table_rows"]],
  ["table-cell-style", "table-style", ["set_table_cell_format"]],
  ["table-cell-append", "table-structure", ["set_table_cell"]],
  ["table-cell-text", "table-structure", ["set_table_cell"]],
  ["chart-data", "chart-data", ["set_chart_data"]],
  ["chart-type", "chart-type", ["set_chart_type"]],
  ["slide-transition", "slide-transition", ["set_slide_transition"]],
  ["animation-timing", "animation-timing", ["set_animation_timing"]],
  ["object-hyperlink", "object-interaction", ["set_object_interaction"]],
  ["shape-fill", "general-native-surface", ["set_shape_fill", "fill_color"]],
  ["slide-background", "layout-master", ["set_background"]],
  ["layout-switch", "layout-master", ["set_slide_layout"]],
  ["shape-insert", "general-native-surface", ["add_shape"]],
  ["wordart-insert", "fontwork", []], // Creation does not test set_fontwork.
  ["smartart-move", "smartart-diagram", ["move"]],
  ["picture-crop", "picture-crop", ["crop_image"]],
  ["smartart-text", "smartart-diagram", ["set_smartart_node"]],
  ["smartart-add", "smartart-diagram", ["add_smartart_node"]],
  ["smartart-delete", "smartart-diagram", ["delete_smartart_node"]],
];
export const typedComparisonCases = Object.freeze(
  Object.fromEntries(
    definitions.map(([id, scenario, relatedOperations]) => [
      id,
      Object.freeze({
        scenario,
        relatedOperations: Object.freeze(relatedOperations),
      }),
    ]),
  ),
);
export const comparisonTrialModes = Object.freeze([
  "normal",
  "rollback",
  "rollback-redo",
]);

export function buildOnlyOfficeComparisonPlan(
  capabilities,
  conformance,
  selectedCases = Object.keys(typedComparisonCases),
) {
  if (
    !selectedCases.length ||
    new Set(selectedCases).size !== selectedCases.length
  )
    throw new Error("Distinct nonempty comparison cases required");
  const productPlan = buildConformancePlan(capabilities, conformance, {
    runtime: "browser",
  });
  const expectedOperations = Object.values(productPlan.families)
    .flatMap((family) => family.operations)
    .sort();
  const cases = selectedCases.map((id) => {
    const definition = typedComparisonCases[id];
    if (!definition) throw new Error("Unknown comparison case: " + id);
    const scenario = conformance.scenarios[definition.scenario];
    if (!scenario || !/^[0-9a-f]{64}$/u.test(scenario.sourceSha256 ?? ""))
      throw new Error("Missing immutable fixture for " + id);
    for (const operation of definition.relatedOperations)
      if (!expectedOperations.includes(operation))
        throw new Error(
          "Comparison refers to missing product operation: " + operation,
        );
    return {
      id,
      ...definition,
      source: scenario.source,
      sourceSha256: scenario.sourceSha256,
    };
  });
  const related = new Set(cases.flatMap((value) => value.relatedOperations));
  return {
    schemaVersion: 1,
    contractVersion: productPlan.contractVersion,
    mutationContractVersion: productPlan.mutationContractVersion,
    expectedOperations,
    cases,
    trials: cases.flatMap((value) =>
      comparisonTrialModes.map((mode) => ({ caseId: value.id, mode })),
    ),
    operationsWithoutRelatedDiagnostic: expectedOperations.filter(
      (operation) => !related.has(operation),
    ),
    admissionStatus: "not_admitted",
    proofScope:
      "Typed native SDK diagnostics only; related operations do not prove the full product command, observation, preservation, recovery, playback or independent PowerPoint contract.",
  };
}

export function summarizeOnlyOfficeBatch(plan, rows) {
  const key = (value) => value.caseId + ":" + value.mode;
  const expected = new Map(plan.trials.map((value) => [key(value), value]));
  const seen = new Set(),
    failures = [],
    completed = [];
  for (const row of rows) {
    const id = key(row);
    if (!expected.has(id) || seen.has(id)) {
      failures.push({ trial: id, error: "unknown_or_duplicate_trial" });
      continue;
    }
    seen.add(id);
    const fixture = plan.cases.find((value) => value.id === row.caseId);
    const evidence = row.report,
      item = evidence?.cases?.[0];
    const normal = row.mode === "normal";
    const verified =
      row.exitCode === 0 &&
      row.sameBuild === true &&
      evidence?.sourceStable === true &&
      evidence?.candidateCodeStable === true &&
      evidence?.candidateDistributionStable === true &&
      evidence?.inputFontCoverage?.valid === true &&
      evidence?.inputSha256 === fixture.sourceSha256 &&
      evidence?.cases?.length === 1 &&
      item?.typedCase === row.caseId &&
      item.status ===
        (normal
          ? "typed-apply-save-history-reopen-verified"
          : "typed-failed-mutation-rollback-verified") &&
      (normal ||
        (item.rollbackVerified === true && item.expectedFailure === true)) &&
      (row.mode !== "rollback-redo" ||
        item.preexistingRedo?.replayedAndUndone === true);
    if (verified) completed.push(id);
    else
      failures.push({ trial: id, error: "missing_or_failed_trial_evidence" });
  }
  const missing = [...expected.keys()].filter((id) => !seen.has(id));
  return {
    expectedTrials: expected.size,
    verifiedTrials: completed.length,
    missingTrials: missing,
    failures,
    completeWithinSelectedDiagnostics:
      missing.length === 0 && failures.length === 0,
    admissionStatus: "not_admitted",
    productOperations: plan.expectedOperations.length,
    operationsWithoutRelatedDiagnostic: plan.operationsWithoutRelatedDiagnostic,
  };
}
