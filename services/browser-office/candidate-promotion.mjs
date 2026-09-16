import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { admitCandidateRuntime } from "./candidate-runtime.mjs";
import {
  browserRuntimeBuildInputPaths,
  readRepositoryIdentity,
  readRepositoryPathEquivalence,
} from "./repository-identity.mjs";
import {
  candidateBrowserReportErrors,
  candidateNativeConformanceErrors,
} from "./verify-candidate-powerpoint.mjs";

export function createCandidatePromotion({
  admittedRuntime,
  integrationSource,
  runtimeBuildInputEquivalence,
  browserReport,
  browserReportSha256,
  nativeConformanceReport,
  nativeConformanceReportSha256,
  powerpointReport,
  powerpointReportSha256,
  verifiedAt = new Date().toISOString(),
}) {
  const errors = [
    ...candidateBrowserReportErrors(browserReport),
    ...candidateNativeConformanceErrors(nativeConformanceReport),
  ];
  if (
    !/^[0-9a-f]{40}$/u.test(integrationSource?.revision ?? "") ||
    integrationSource?.dirty !== false ||
    integrationSource.revision !== browserReport.integrationSource?.revision
  )
    errors.push("promotion is not running from the verified clean source");
  if (
    runtimeBuildInputEquivalence?.buildSourceRevision !==
      admittedRuntime.receipt.spellbookSourceRevision ||
    runtimeBuildInputEquivalence?.integrationSourceRevision !==
      integrationSource?.revision ||
    runtimeBuildInputEquivalence?.exact !== true ||
    !Array.isArray(runtimeBuildInputEquivalence?.inputs) ||
    runtimeBuildInputEquivalence.inputs.length !==
      browserRuntimeBuildInputPaths.length ||
    !browserRuntimeBuildInputPaths.every((requiredPath) =>
      runtimeBuildInputEquivalence.inputs.some(
        (input) =>
          input?.path === requiredPath &&
          input.exact === true &&
          /^[0-9a-f]{40,64}$/u.test(input.buildObject ?? "") &&
          input.buildObject === input.integrationObject,
      ),
    )
  )
    errors.push(
      "browser runtime build inputs differ from the verified integration source",
    );
  if (
    admittedRuntime.receiptSha256 !==
    browserReport.candidateRuntime?.receiptSha256
  )
    errors.push("browser report does not identify the admitted build receipt");
  if (
    admittedRuntime.receiptSha256 !==
    nativeConformanceReport?.candidateReceiptSha256
  )
    errors.push(
      "native conformance report does not identify the admitted build receipt",
    );
  if (
    browserReport.integrationSource?.revision !==
    nativeConformanceReport?.integrationSource?.revision
  )
    errors.push("browser evidence does not identify one integration source");
  if (powerpointReport?.valid !== true || powerpointReport.errors?.length !== 0)
    errors.push("native PowerPoint evidence is not valid");
  if (powerpointReport?.browserReceiptSha256 !== admittedRuntime.receiptSha256)
    errors.push(
      "PowerPoint evidence does not identify the admitted build receipt",
    );
  if (powerpointReport?.savedSha256 !== browserReport.savedSha256)
    errors.push("PowerPoint evidence does not identify the browser-saved PPTX");
  if (
    powerpointReport?.nativeConformanceSha256 !== nativeConformanceReportSha256
  )
    errors.push(
      "PowerPoint evidence does not identify the native conformance report",
    );
  if (
    powerpointReport?.integrationSourceRevision !==
    browserReport.integrationSource?.revision
  )
    errors.push(
      "PowerPoint evidence does not identify the integration source revision",
    );
  if (!/^[0-9a-f]{64}$/u.test(browserReportSha256 ?? ""))
    errors.push("browser evidence digest is invalid");
  if (!/^[0-9a-f]{64}$/u.test(nativeConformanceReportSha256 ?? ""))
    errors.push("native conformance evidence digest is invalid");
  if (!/^[0-9a-f]{64}$/u.test(powerpointReportSha256 ?? ""))
    errors.push("PowerPoint evidence digest is invalid");
  if (errors.length) throw new Error(errors.join("; "));

  return {
    schemaVersion: 1,
    status: "verified_not_published",
    verifiedAt,
    spellbookSourceRevision: browserReport.integrationSource.revision,
    runtime: {
      receiptSha256: admittedRuntime.receiptSha256,
      buildSourceRevision: admittedRuntime.receipt.spellbookSourceRevision,
      buildInputEquivalence: runtimeBuildInputEquivalence,
      libreOffice: admittedRuntime.receipt.libreOffice,
      toolchain: admittedRuntime.receipt.toolchain,
      artifacts: admittedRuntime.receipt.artifacts,
    },
    evidence: {
      browserReportSha256,
      nativeConformanceReportSha256,
      powerpointReportSha256,
      verifiedElementOperations: browserReport.verifiedElementOperations,
      verifiedNativeOperations: nativeConformanceReport.executedOperations,
      enduranceCycles: browserReport.endurance.cycles,
      changedParts: browserReport.changedParts,
      nativeSnapshotChangedParts: browserReport.nativeSnapshotChangedParts,
      savedSha256: browserReport.savedSha256,
      powerpointRenderer: powerpointReport.renderer,
      powerpointSlideCounts: powerpointReport.slideCounts,
      powerpointVisibleEdit: powerpointReport.visibleEdit,
    },
  };
}

async function main() {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const runtimeDirectory = path.resolve(
    requiredFlagValue("--candidate-runtime", process.argv),
  );
  const browserReportPath = path.resolve(
    requiredFlagValue("--browser-report", process.argv),
  );
  const nativeConformanceReportPath = path.resolve(
    requiredFlagValue("--native-conformance", process.argv),
  );
  const powerpointReportPath = path.resolve(
    requiredFlagValue("--powerpoint-report", process.argv),
  );
  const output = path.resolve(requiredFlagValue("--output", process.argv));
  const admittedRuntime = await admitCandidateRuntime({ runtimeDirectory });
  const integrationSource = readRepositoryIdentity(repositoryRoot);
  const runtimeBuildInputEquivalence = readRepositoryPathEquivalence(
    repositoryRoot,
    admittedRuntime.receipt.spellbookSourceRevision,
    integrationSource.revision,
  );
  const [browserBytes, nativeConformanceBytes, powerpointBytes] =
    await Promise.all([
      fs.readFile(browserReportPath),
      fs.readFile(nativeConformanceReportPath),
      fs.readFile(powerpointReportPath),
    ]);
  const promotion = createCandidatePromotion({
    admittedRuntime,
    integrationSource,
    runtimeBuildInputEquivalence,
    browserReport: JSON.parse(browserBytes.toString("utf8")),
    browserReportSha256: sha256(browserBytes),
    nativeConformanceReport: JSON.parse(
      nativeConformanceBytes.toString("utf8"),
    ),
    nativeConformanceReportSha256: sha256(nativeConformanceBytes),
    powerpointReport: JSON.parse(powerpointBytes.toString("utf8")),
    powerpointReportSha256: sha256(powerpointBytes),
  });
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(promotion, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify(promotion, null, 2)}\n`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requiredFlagValue(name, argv) {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : null;
  if (!value || value.startsWith("--")) throw new Error(`${name} is required.`);
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
