/* SPDX-License-Identifier: MPL-2.0 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildOnlyOfficeComparisonPlan,
  summarizeOnlyOfficeBatch,
} from "./onlyoffice/comparison-plan.mjs";
import {
  readRepositoryIdentity,
  readRepositoryEvidence,
  repositoryIdentityStable,
} from "./repository-identity.mjs";
import { readOfficeDistributionEvidence } from "./distribution-check.mjs";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const flag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  if (i >= 0) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error("Missing " + name);
};
const output = path.resolve(flag("--output")),
  candidate = path.resolve(flag("--candidate-root")),
  origin = flag("--origin");
const [capabilities, conformance] = await Promise.all([
  readFile(
    path.join(root, "contracts/native-edit-capabilities.json"),
    "utf8",
  ).then(JSON.parse),
  readFile(
    path.join(root, "contracts/native-mutation-conformance.json"),
    "utf8",
  ).then(JSON.parse),
]);
const selection = flag("--cases", "");
const plan = buildOnlyOfficeComparisonPlan(
  capabilities,
  conformance,
  selection ? selection.split(",") : undefined,
);
const integration = readRepositoryIdentity(root),
  candidateSource = readRepositoryIdentity(candidate);
assert(
  !integration.dirty && !candidateSource.dirty,
  "Commit candidate and integration sources before recording a batch",
);
const distribution = await readOfficeDistributionEvidence(
  path.join(candidate, "dist"),
);
assert(distribution.valid, "Verified complete candidate distribution required");
await mkdir(output, { recursive: false });
const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  plan,
  integration,
  candidate: candidateSource,
  distribution,
  rows: [],
  status: "running",
};
const save = async () => {
  report.summary = summarizeOnlyOfficeBatch(plan, report.rows);
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
};
let child = null,
  interrupted = false;
const terminateChild = (signal) => {
  if (child) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  }
};
const stop = () => {
  interrupted = true;
  terminateChild("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  await save();
  for (const trial of plan.trials) {
    if (interrupted) throw new Error("Comparison batch interrupted");
    const definition = plan.cases.find((value) => value.id === trial.caseId),
      input = path.resolve(root, definition.source);
    const actual = createHash("sha256")
      .update(await readFile(input))
      .digest("hex");
    assert.equal(
      actual,
      definition.sourceSha256,
      "Canonical fixture changed: " + trial.caseId,
    );
    assert(
      repositoryIdentityStable(integration, readRepositoryIdentity(root)) &&
        repositoryIdentityStable(
          candidateSource,
          readRepositoryIdentity(candidate),
        ),
      "Source changed during batch",
    );
    const trialOutput = path.join(output, trial.caseId + "-" + trial.mode),
      started = Date.now();
    const args = [
      path.join(
        root,
        "services/browser-office/verify-onlyoffice-typed-comparison.mjs",
      ),
      "--candidate-root",
      candidate,
      "--origin",
      origin,
      "--input",
      input,
      "--output",
      trialOutput,
      "--typed-case",
      trial.caseId,
      ...(trial.mode !== "normal" ? ["--fail-after-apply"] : []),
      ...(trial.mode === "rollback-redo" ? ["--preexisting-redo"] : []),
    ];
    let log = "";
    const exitCode = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, args, {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      let graceTimer;
      const timer = setTimeout(() => {
        terminateChild("SIGTERM");
        graceTimer = setTimeout(() => terminateChild("SIGKILL"), 15000);
      }, 300000);
      child.stdout.on("data", (bytes) => (log += bytes));
      child.stderr.on("data", (bytes) => (log += bytes));
      child.once("error", (error) => {
        clearTimeout(timer);
        clearTimeout(graceTimer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        clearTimeout(graceTimer);
        child = null;
        resolve(code ?? 1);
      });
    });
    await writeFile(
      path.join(output, trial.caseId + "-" + trial.mode + ".log"),
      log,
    );
    const evidence = await readFile(
      path.join(trialOutput, "report.json"),
      "utf8",
    )
      .then(JSON.parse)
      .catch(() => null);
    const sameBuild =
      evidence &&
      repositoryIdentityStable(integration, evidence.integration) &&
      repositoryIdentityStable(candidateSource, evidence.candidate) &&
      evidence.candidateDistribution?.distributionSha256 ===
        distribution.distributionSha256;
    report.rows.push({
      sameBuild,
      ...trial,
      exitCode,
      durationMs: Date.now() - started,
      report: evidence,
    });
    await save();
    process.stdout.write(JSON.stringify({ ...trial, exitCode }) + "\n");
  }
} catch (error) {
  report.error = String(error.message ?? error);
  process.exitCode = 1;
} finally {
  if (interrupted) report.error = "Comparison batch interrupted";
  report.finalIntegration = readRepositoryEvidence(root);
  report.finalCandidate = readRepositoryEvidence(candidate);
  report.finalDistribution = await readOfficeDistributionEvidence(
    path.join(candidate, "dist"),
  );
  report.sourceStable =
    repositoryIdentityStable(integration, report.finalIntegration) &&
    repositoryIdentityStable(candidateSource, report.finalCandidate);
  report.distributionStable =
    report.finalDistribution.valid &&
    report.finalDistribution.distributionSha256 ===
      distribution.distributionSha256;
  await save();
  report.status =
    report.summary.completeWithinSelectedDiagnostics &&
    report.sourceStable &&
    report.distributionStable &&
    !report.error
      ? "diagnostic-batch-verified"
      : "failed";
  report.finishedAt = new Date().toISOString();
  await save();
  if (report.status !== "diagnostic-batch-verified") process.exitCode = 1;
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
