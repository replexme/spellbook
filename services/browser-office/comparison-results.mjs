/* SPDX-License-Identifier: MPL-2.0 */

// Completion belongs to the requested matrix, not the number of successful
// rows a child happened to return. This never admits a production engine.
export function summarizeEngineComparison({
  inputs,
  engines,
  cases,
  preserveSource,
  repairStructure,
  sourceStable,
}) {
  const expected = inputs.flatMap((input) =>
    engines.flatMap((engine) =>
      input.scenarios.map((scenario) => `${input.label}/${engine}/${scenario}`),
    ),
  );
  const rows = new Map(),
    failures = [];
  if (expected.length === 0)
    failures.push({ key: "matrix", reason: "empty_matrix" });
  if (sourceStable !== true)
    failures.push({
      key: "source",
      reason: "source_identity_changed_or_unverified",
    });
  const onlyofficeStatus = preserveSource
    ? "source-preserved-save-reopen-verified"
    : repairStructure
      ? "repaired-export-reopen-verified"
      : "raw-export-reopen-verified";
  for (const cell of cases) {
    const key = `${cell.label}/${cell.engine}/${cell.scenario}`;
    if (!expected.includes(key)) {
      failures.push({ key, reason: "unexpected_or_unbound_result" });
      continue;
    }
    if (rows.has(key)) failures.push({ key, reason: "duplicate_result" });
    rows.set(key, cell);
  }
  for (const key of expected) {
    const cell = rows.get(key);
    if (!cell) {
      failures.push({ key, reason: "missing_result" });
      continue;
    }
    const succeeded =
      cell.engine === "native"
        ? cell.outcome === "saved" && !cell.note
        : cell.status === onlyofficeStatus;
    if (!succeeded || cell.engineProcessCode !== 0)
      failures.push({ key, reason: "scenario_failed" });
    if (
      cell.savedOpenXml?.Valid !== true ||
      cell.savedOpenXml?.validatorFailed === true
    )
      failures.push({ key, reason: "saved_format_failed_or_unverified" });
  }
  const verified = [...rows.values()].filter(
    (cell) =>
      !failures.some(
        (failure) =>
          failure.key === `${cell.label}/${cell.engine}/${cell.scenario}`,
      ),
  );
  return {
    cases: cases.length,
    expectedCases: expected.length,
    verifiedCases: verified.length,
    completeWithinRequestedScenarios:
      failures.length === 0 && verified.length === expected.length,
    proofScope:
      "Human-editing scenarios in the input manifest; excludes the complete product mutation and admission contracts",
    nativeSaved: verified.filter((cell) => cell.engine === "native").length,
    onlyofficeRawVerified: verified.filter(
      (cell) => cell.status === "raw-export-reopen-verified",
    ).length,
    onlyofficeRepairedVerified: verified.filter(
      (cell) => cell.status === "repaired-export-reopen-verified",
    ).length,
    onlyofficeSourcePreservedVerified: verified.filter(
      (cell) => cell.status === "source-preserved-save-reopen-verified",
    ).length,
    refused: cases.filter((cell) => cell.outcome === "refused").length,
    errors: failures.length,
    failures,
  };
}
