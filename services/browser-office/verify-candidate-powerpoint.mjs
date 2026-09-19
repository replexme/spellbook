import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compareEditorImage } from "../../scripts/evaluate-office-editor-corpus.mjs";
import { detectImageMagick } from "../../scripts/evaluate-render-corpus.mjs";
import { exportPowerPointReferences } from "../../scripts/export-powerpoint-references.mjs";
import { buildConformancePlan } from "../../scripts/native-mutation-conformance.mjs";

const serviceRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(serviceRoot, "../..");
const documentTool = path.join(
  repositoryRoot,
  "services/document-worker/tools/Spellbook.Document.Tool/bin/Release/net10.0/Spellbook.Document.Tool.dll",
);
const requiredBridgeOperations = Object.freeze([
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
]);
const nativeCapabilities = JSON.parse(
  await fs.readFile(
    path.join(repositoryRoot, "contracts/native-edit-capabilities.json"),
    "utf8",
  ),
);
const nativeConformance = JSON.parse(
  await fs.readFile(
    path.join(repositoryRoot, "contracts/native-mutation-conformance.json"),
    "utf8",
  ),
);
// The browser candidate is admitted against the browser plan: operations the
// contract marks unavailable in that runtime (media, WordArt) and scenarios
// left without operations are not required of it.
const browserNativePlan = buildConformancePlan(
  nativeCapabilities,
  nativeConformance,
  { enginePatchLevel: nativeConformance.enginePatchLevel, runtime: "browser" },
);
const requiredNativeOperations = Object.freeze(
  Object.values(browserNativePlan.families)
    .flatMap((family) => family.operations)
    .sort(),
);
const requiredNativeScenarios = Object.freeze(
  Object.keys(browserNativePlan.scenarios).sort(),
);

export function candidateBrowserReportErrors(report) {
  const errors = [];
  if (report?.status !== "browser-product-bridge-verified")
    errors.push("product bridge status is not verified");
  if (report?.patchedBrowserRuntime !== true)
    errors.push("browser runtime is not the admitted patched candidate");
  if (!/^[0-9a-f]{64}$/u.test(report?.candidateRuntime?.receiptSha256 ?? ""))
    errors.push("candidate build receipt is not bound to the report");
  if (
    !/^[0-9a-f]{40}$/u.test(report?.integrationSource?.revision ?? "") ||
    report?.integrationSource?.dirty !== false
  )
    errors.push(
      "browser bridge evidence is not bound to a clean source commit",
    );
  if (
    !sameStringSet(report?.verifiedElementOperations, requiredBridgeOperations)
  )
    errors.push(
      "the complete 17-operation bridge endurance subset was not verified",
    );
  if (
    report?.endurance?.status !== "browser-product-endurance-verified" ||
    !Number.isSafeInteger(report?.endurance?.cycles) ||
    report.endurance.cycles < 100
  )
    errors.push("the single-session endurance run did not reach 100 cycles");
  if (!sameStringSet(report?.endurance?.operations, requiredBridgeOperations))
    errors.push("endurance did not rotate through all 17 element operations");
  if (JSON.stringify(report?.changedParts) !== '["ppt/slides/slide1.xml"]')
    errors.push("the final edit changed collateral OOXML parts");
  if (
    report?.nativeSnapshotPersisted !== true ||
    report?.nativeSnapshotPreserved !== true ||
    JSON.stringify(report?.nativeSnapshotChangedParts) !==
      '["ppt/slides/slide1.xml"]'
  )
    errors.push("the native edit rewrote unrelated original PPTX parts");
  if (report?.replacement?.includes("product bridge") !== true)
    errors.push("the saved text replacement is missing from the report");
  if (!/^[0-9a-f]{64}$/u.test(report?.savedSha256 ?? ""))
    errors.push("the saved PPTX digest is missing");
  if (report?.postSaveEditRecovered !== true)
    errors.push(
      "an edit made during save did not survive acknowledgement and reopen",
    );
  if ((report?.pageErrors?.length ?? -1) !== 0)
    errors.push("the browser run emitted page errors");
  if ((report?.requestFailures?.length ?? -1) !== 0)
    errors.push("the browser run emitted request failures");
  return errors;
}

export function candidateNativeConformanceErrors(report) {
  const errors = [];
  if (report?.status !== "browser-native-conformance-verified")
    errors.push("browser native conformance status is not verified");
  if (!/^[0-9a-f]{64}$/u.test(report?.candidateReceiptSha256 ?? ""))
    errors.push("browser native conformance has no candidate receipt");
  if (
    !/^[0-9a-f]{40}$/u.test(report?.integrationSource?.revision ?? "") ||
    report?.integrationSource?.dirty !== false
  )
    errors.push(
      "browser native conformance is not bound to a clean source commit",
    );
  if (!sameStringSet(report?.expectedOperations, requiredNativeOperations))
    errors.push("browser native conformance expected-operation set differs");
  if (!sameStringSet(report?.executedOperations, requiredNativeOperations))
    errors.push("the complete native operation contract was not executed");
  if ((report?.missingOperations?.length ?? -1) !== 0)
    errors.push("browser native conformance reports missing operations");
  if (
    !Array.isArray(report?.scenarios) ||
    !sameStringSet(
      report.scenarios.map((scenario) => scenario?.scenario),
      requiredNativeScenarios,
    )
  )
    errors.push(
      `browser native conformance did not run all ${requiredNativeScenarios.length} contract scenarios`,
    );
  else
    for (const scenario of report.scenarios) {
      if (
        scenario?.status !== "passed" ||
        scenario?.baseline?.reopened !== true ||
        !/^[0-9a-f]{64}$/u.test(scenario?.baseline?.sha256 ?? "") ||
        !/^[0-9a-f]{64}$/u.test(scenario?.candidate?.sha256 ?? "") ||
        !/^[0-9a-f]{64}$/u.test(scenario?.mutationReportSha256 ?? "") ||
        scenario?.reopenVerified !== true ||
        scenario?.missingSelectedOperations?.length !== 0 ||
        (scenario?.changeBudget?.valid ?? scenario?.changeBudget?.Valid) !==
          true
      )
        errors.push(
          `browser native scenario is incomplete: ${scenario?.scenario ?? "unknown"}`,
        );
    }
  return errors;
}

async function main() {
  const evidenceRoot = path.resolve(
    requiredFlagValue("--browser-evidence", process.argv),
  );
  const outputRoot = path.resolve(
    optionalFlagValue("--output", process.argv) ??
      path.join(
        repositoryRoot,
        "artifacts/browser-office/candidate-powerpoint",
      ),
  );
  const browserReport = JSON.parse(
    await fs.readFile(path.join(evidenceRoot, "result.json"), "utf8"),
  );
  const nativeConformancePath = path.resolve(
    requiredFlagValue("--native-conformance", process.argv),
  );
  const nativeConformance = JSON.parse(
    await fs.readFile(nativeConformancePath, "utf8"),
  );
  const errors = [
    ...candidateBrowserReportErrors(browserReport),
    ...candidateNativeConformanceErrors(nativeConformance),
  ];
  if (
    nativeConformance.candidateReceiptSha256 !==
    browserReport.candidateRuntime?.receiptSha256
  )
    errors.push("browser bridge and native conformance use different runtimes");
  if (
    nativeConformance.integrationSource?.revision !==
    browserReport.integrationSource?.revision
  )
    errors.push(
      "browser bridge and native conformance use different integration sources",
    );
  const candidateDeck = path.join(evidenceRoot, "saved-product-bridge.pptx");
  const candidateBytes = await fs.readFile(candidateDeck);
  if (sha256(candidateBytes) !== browserReport.savedSha256)
    errors.push("saved PPTX bytes differ from the browser report digest");
  await fs.access(documentTool);
  const openXmlValidation = JSON.parse(
    requireCommand("dotnet", [documentTool, "validate-openxml", candidateDeck])
      .stdout,
  );
  if ((openXmlValidation.valid ?? openXmlValidation.Valid) !== true)
    errors.push("Open XML SDK rejected the saved browser candidate");
  if (errors.length) throw new Error(errors.join("; "));

  await fs.mkdir(path.dirname(outputRoot), { recursive: true });
  const runRoot = await fs.mkdtemp(`${outputRoot}-`);
  const manifestPath = path.join(runRoot, "manifest.json");
  const referencesRoot = path.join(runRoot, "references");
  const sourceDeck = path.join(
    repositoryRoot,
    "eval/public/fixtures/general-native-surface.pptx",
  );
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        contractVersion: "1.0",
        decks: [
          { id: "source", source: sourceDeck },
          { id: "candidate", source: candidateDeck },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const exported = await exportPowerPointReferences({
    manifestPath,
    referencesRoot,
  });
  for (const failure of exported.failures)
    errors.push(`${failure.id}: ${failure.error}`);
  const slideCounts = {};
  if (exported.failures.length === 0)
    for (const id of ["source", "candidate"]) {
      const metadata = JSON.parse(
        await fs.readFile(
          path.join(referencesRoot, id, "reference-metadata.json"),
          "utf8",
        ),
      );
      slideCounts[id] = metadata.slides;
      if (metadata.slides !== 1)
        errors.push(`${id}: PowerPoint exported ${metadata.slides} slides`);
    }

  let visibleEdit = null;
  const imageMagick = detectImageMagick();
  if (!imageMagick) errors.push("ImageMagick is unavailable for pixel checks");
  else if (exported.failures.length === 0) {
    visibleEdit = compareEditorImage(
      path.join(referencesRoot, "source", "slide-1.png"),
      path.join(referencesRoot, "candidate", "slide-1.png"),
      imageMagick,
    );
    if (
      visibleEdit.normalizedRmse === null ||
      visibleEdit.normalizedRmse <= 0 ||
      visibleEdit.normalizedRmse >= 0.1
    )
      errors.push(
        `PowerPoint visual delta is absent or unbounded: ${visibleEdit.normalizedRmse}`,
      );
  }

  const extractedText =
    exported.failures.length === 0
      ? extractPdfText(path.join(referencesRoot, "candidate", "reference.pdf"))
      : "";
  for (const token of ["Spellbook", "product bridge"])
    if (!extractedText.includes(token))
      errors.push(`PowerPoint PDF omits expected text: ${token}`);

  const result = {
    valid: errors.length === 0,
    errors,
    browserEvidenceRoot: evidenceRoot,
    browserReceiptSha256: browserReport.candidateRuntime.receiptSha256,
    integrationSourceRevision: browserReport.integrationSource.revision,
    nativeConformanceSha256: sha256(await fs.readFile(nativeConformancePath)),
    verifiedNativeOperations: nativeConformance.executedOperations,
    savedSha256: browserReport.savedSha256,
    openXmlValidation,
    outputRoot: runRoot,
    renderer: exported.referenceRenderer,
    slideCounts,
    visibleEdit,
    extractedTextChecks: {
      Spellbook: extractedText.includes("Spellbook"),
      productBridge: extractedText.includes("product bridge"),
    },
  };
  await fs.writeFile(
    path.join(runRoot, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    { mode: 0o600 },
  );
  if (!result.valid) throw new Error(errors.join("; "));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function sameStringSet(actual, expected) {
  const sortedExpected = [...expected].sort();
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    [...actual].sort().every((value, index) => value === sortedExpected[index])
  );
}

function extractPdfText(pdf) {
  const result = requireCommand("pdftotext", ["-layout", pdf, "-"]);
  return result.stdout.replace(/\s+/gu, " ").trim();
}

function requireCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0)
    throw new Error(
      [result.error?.message, result.stderr, result.stdout]
        .filter(Boolean)
        .join(" ") || `${command} exited with ${result.status}`,
    );
  return result;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function optionalFlagValue(name, argv) {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value.`);
  return value;
}

function requiredFlagValue(name, argv) {
  const value = optionalFlagValue(name, argv);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
