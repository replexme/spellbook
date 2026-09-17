import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { buildConformancePlan } from "../../scripts/native-mutation-conformance.mjs";
import {
  buildChangeBudget,
  buildScenarioExecutionPlan,
  operationsFromReport,
  withNoopSaveBaseline,
} from "../../scripts/native-mutation-conformance-runner.mjs";
import { admitCandidateRuntime } from "./candidate-runtime.mjs";
import { readRepositoryIdentity } from "./repository-identity.mjs";
import { createHarnessServer } from "./server.mjs";

const serviceRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(serviceRoot, "../..");
const repositoryIdentity = readRepositoryIdentity(repositoryRoot);
const capabilitiesPath = path.join(
  repositoryRoot,
  "contracts/native-edit-capabilities.json",
);
const conformancePath = path.join(
  repositoryRoot,
  "contracts/native-mutation-conformance.json",
);
const documentToolProject = path.join(
  repositoryRoot,
  "services/document-worker/tools/Spellbook.Document.Tool/Spellbook.Document.Tool.csproj",
);
const documentTool = path.join(
  repositoryRoot,
  "services/document-worker/tools/Spellbook.Document.Tool/bin/Release/net10.0/Spellbook.Document.Tool.dll",
);
const processTimeoutMs = 300_000;

const candidateRuntimePath = path.resolve(
  requiredFlagValue("--candidate-runtime"),
);
const outputRoot = path.resolve(
  optionalFlagValue("--output") ??
    path.join(repositoryRoot, "artifacts/browser-office/native-conformance"),
);

await ensureNewDirectory(outputRoot);
const [capabilities, conformance, candidateRuntime] = await Promise.all([
  readJson(capabilitiesPath),
  readJson(conformancePath),
  admitCandidateRuntime({ runtimeDirectory: candidateRuntimePath }),
]);
const plan = buildConformancePlan(capabilities, conformance, {
  enginePatchLevel: conformance.enginePatchLevel,
});
if (!plan.summary.complete)
  throw new Error(
    `Native conformance definition has ${plan.summary.missingGates} uncovered gates.`,
  );
const onlyScenario = optionalFlagValue("--only-scenario");
const onlyScenarios = optionalFlagValue("--only-scenarios")?.split(",") ?? null;
const diagnosticAll = process.argv.includes("--diagnostic-all");
if (onlyScenario && diagnosticAll)
  throw new Error("--only-scenario and --diagnostic-all cannot be combined.");
if (onlyScenario && onlyScenarios)
  throw new Error("Select either --only-scenario or --only-scenarios.");
const allScenarios = buildScenarioExecutionPlan(
  capabilities,
  conformance,
  plan,
);
if (onlyScenario && !allScenarios.some(({ name }) => name === onlyScenario))
  throw new Error(`Unknown native conformance scenario: ${onlyScenario}.`);
const selectedNames = onlyScenarios ?? (onlyScenario ? [onlyScenario] : null);
if (
  selectedNames &&
  (selectedNames.some(
    (name) => !allScenarios.some((scenario) => scenario.name === name),
  ) ||
    new Set(selectedNames).size !== selectedNames.length)
)
  throw new Error("--only-scenarios needs distinct known scenario names.");
const scenarios = selectedNames
  ? allScenarios.filter(({ name }) => selectedNames.includes(name))
  : allScenarios;

await runProcess(
  dotnetHostCommand(),
  ["build", documentToolProject, "--configuration", "Release", "--nologo"],
  path.join(outputRoot, "document-tool-build.log"),
);

const report = {
  schemaVersion: 1,
  status: "running",
  startedAt: new Date().toISOString(),
  candidateReceiptSha256: candidateRuntime.receiptSha256,
  spellbookSourceRevision: candidateRuntime.receipt.spellbookSourceRevision,
  integrationSource: repositoryIdentity,
  runtime: {
    libreOffice: candidateRuntime.receipt.libreOffice,
    toolchain: candidateRuntime.receipt.toolchain,
    artifacts: candidateRuntime.receipt.artifacts,
  },
  contractVersion: conformance.version,
  mutationContractVersion: capabilities.mutationModel.version,
  ...(onlyScenario ? { diagnosticScenario: onlyScenario } : {}),
  ...(onlyScenarios ? { diagnosticScenarios: selectedNames } : {}),
  ...(diagnosticAll ? { diagnosticAll: true } : {}),
  expectedOperations: Object.keys(capabilities.mutationModel.operations)
    .filter(
      (operation) =>
        capabilities.mutationModel.operations[operation].availability !==
        "format_excluded",
    )
    .sort(),
  scenarios: [],
  scenarioFailures: [],
};
const reportPath = path.join(outputRoot, "conformance-report.json");
await writeReport(reportPath, report);

try {
  for (const scenario of scenarios) {
    const startedAt = Date.now();
    try {
      const result = await runScenario({
        scenario,
        capabilities,
        candidateRuntime,
      });
      report.scenarios.push(result);
    } catch (error) {
      if (!diagnosticAll) throw error;
      report.scenarioFailures.push({
        scenario: scenario.name,
        selectedOperations: scenario.selectedOperations,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await writeReport(reportPath, report);
  }
  report.executedOperations = [
    ...new Set(report.scenarios.flatMap(({ operations }) => operations)),
  ].sort();
  report.missingOperations = report.expectedOperations.filter(
    (operation) => !report.executedOperations.includes(operation),
  );
  if (report.scenarioFailures.length)
    throw new Error(
      `Browser candidate failed ${report.scenarioFailures.length} of ${scenarios.length} native scenarios: ${report.scenarioFailures.map(({ scenario }) => scenario).join(", ")}.`,
    );
  if (!selectedNames && report.missingOperations.length)
    throw new Error(
      `Browser candidate did not execute: ${report.missingOperations.join(", ")}.`,
    );
  report.status = selectedNames
    ? "diagnostic-scenario-verified"
    : "browser-native-conformance-verified";
  report.completedAt = new Date().toISOString();
  await writeReport(reportPath, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  report.status = "failed";
  report.completedAt = new Date().toISOString();
  report.error = error instanceof Error ? error.message : String(error);
  await writeReport(reportPath, report);
  throw error;
}

async function runScenario({ scenario, capabilities, candidateRuntime }) {
  const started = Date.now();
  const scenarioRoot = path.join(outputRoot, scenario.name);
  await fs.mkdir(scenarioRoot);
  const source = path.resolve(repositoryRoot, scenario.source);
  const sourceSha256 = await sha256File(source);
  if (sourceSha256 !== scenario.sourceSha256)
    throw new Error(
      `${scenario.name} source changed: expected ${scenario.sourceSha256}, got ${sourceSha256}.`,
    );

  const baseline = path.join(scenarioRoot, "baseline.pptx");
  await runBrowserProbe({
    candidateRuntime,
    source,
    output: baseline,
    script: "services/office-session-spike/probe-native-save-noop.mjs",
    logPath: path.join(scenarioRoot, "baseline.log"),
  });
  const baselineReopened = await runBrowserProbe({
    candidateRuntime,
    source: baseline,
    script: "services/office-session-spike/probe-uno-read.mjs",
    logPath: path.join(scenarioRoot, "baseline-reopen.log"),
  });

  const mutationReportPath = path.join(scenarioRoot, "mutation-report.json");
  const candidate = path.join(scenarioRoot, "candidate.pptx");
  await runBrowserProbe({
    candidateRuntime,
    source,
    output: candidate,
    script: scenario.apply.script,
    args: [mutationReportPath, ...(scenario.apply.args ?? [])],
    env: {
      ...(scenario.apply.env ?? {}),
      SPELLBOOK_PROBE_EXPECTED_PATCH_LEVEL:
        candidateRuntime.receipt.libreOffice.patchLevel,
      SPELLBOOK_PROBE_EXPECTED_OPERATIONS: JSON.stringify(
        scenario.allowedOperations,
      ),
      ...visualEnvironment(scenarioRoot, "apply", scenario.name),
    },
    logPath: path.join(scenarioRoot, "mutation.log"),
  });
  const mutationReport = withNoopSaveBaseline(
    await readJson(mutationReportPath),
    baselineReopened.stdout,
  );
  await fs.writeFile(
    mutationReportPath,
    `${JSON.stringify(mutationReport, null, 2)}\n`,
  );
  const operations = operationsFromReport(mutationReport);
  const disallowed = operations.filter(
    (operation) => !scenario.allowedOperations.includes(operation),
  );
  const missingSelectedOperations = scenario.selectedOperations.filter(
    (operation) => !operations.includes(operation),
  );
  // A fixture may route an entire family to several complementary scenarios
  // (for example chart data and chart type). Only the complete matrix, not
  // each individual scenario, must execute every selected operation.
  if (disallowed.length)
    throw new Error(
      `${scenario.name} operation mismatch: disallowed=${disallowed.join(",") || "none"}; missing=${missingSelectedOperations.join(",") || "none"}.`,
    );

  await runBrowserProbe({
    candidateRuntime,
    source: candidate,
    script: scenario.reopen.script,
    args: [mutationReportPath, ...(scenario.reopen.args ?? [])],
    env: {
      ...(scenario.reopen.env ?? {}),
      SPELLBOOK_PROBE_EXPECTED_PATCH_LEVEL:
        candidateRuntime.receipt.libreOffice.patchLevel,
      ...visualEnvironment(scenarioRoot, "reopen", scenario.name),
    },
    logPath: path.join(scenarioRoot, "reopen.log"),
  });

  const budget = buildChangeBudget(
    capabilities,
    operations,
    scenario.targetSlideIndexes,
  );
  const budgetPath = path.join(scenarioRoot, "change-budget.json");
  await fs.writeFile(budgetPath, `${JSON.stringify(budget, null, 2)}\n`);
  const validation = await runProcess(
    dotnetHostCommand(),
    [documentTool, "validate-change-budget", baseline, candidate, budgetPath],
    path.join(scenarioRoot, "change-budget.log"),
  );
  const changeBudget = JSON.parse(validation.stdout);
  if ((changeBudget.valid ?? changeBudget.Valid) !== true)
    throw new Error(`${scenario.name} exceeded its package change budget.`);

  return {
    scenario: scenario.name,
    status: "passed",
    durationMs: Date.now() - started,
    source: { path: scenario.source, sha256: sourceSha256 },
    baseline: {
      sha256: await sha256File(baseline),
      reopened: true,
    },
    candidate: { sha256: await sha256File(candidate) },
    operations,
    selectedOperations: scenario.selectedOperations,
    missingSelectedOperations,
    routedFamilies: scenario.routedFamilies,
    gates: [...new Set([...scenario.proves, "change_budget"])].sort(),
    changeBudget,
    mutationReportSha256: await sha256File(mutationReportPath),
    reopenVerified: true,
  };
}

async function runBrowserProbe({
  candidateRuntime,
  source,
  output,
  script,
  args = [],
  env = {},
  logPath,
}) {
  const server = createHarnessServer({
    runtimeRoot: candidateRuntime.runtimeDirectory,
    runtimeIdentity: candidateRuntime.runtimeIdentity,
    upstream: candidateRuntime.upstream,
    browserProbeSource: source,
    ...(output ? { browserProbeOutput: output } : {}),
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const diagnosticRaw = process.env.SPELLBOOK_DIAGNOSTIC_RAW_DIR
    ? "&nativeRaw=1"
    : "";
  const url = `${origin}/workspace?hostOrigin=${encodeURIComponent(origin)}&browserProbe=1${diagnosticRaw}`;
  try {
    const result = await runProcess(
      process.execPath,
      [path.resolve(repositoryRoot, script), url, ...args],
      logPath,
      env,
    );
    if (output) await fs.access(output);
    return result;
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function runProcess(command, args, logPath, env = {}) {
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  }, processTimeoutMs);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => clearTimeout(timeout));
  await fs.writeFile(
    logPath,
    `${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ""}`,
  );
  if (timedOut)
    throw new Error(`${path.basename(args[0] ?? command)} timed out.`);
  if (exitCode !== 0)
    throw new Error(
      `${path.basename(args[0] ?? command)} exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`,
    );
  return { stdout, stderr, exitCode };
}

function visualEnvironment(scenarioRoot, phase, name) {
  if (phase === "reopen")
    return {
      SPELLBOOK_PROBE_REOPEN_SCREENSHOT: path.join(scenarioRoot, "reopen.png"),
    };
  if (["general-native-surface", "table-structure"].includes(name)) {
    const directory = path.join(scenarioRoot, "apply-screenshots");
    return { SPELLBOOK_PROBE_SCREENSHOT_DIR: directory };
  }
  return {
    SPELLBOOK_PROBE_SCREENSHOT: path.join(scenarioRoot, "apply.png"),
  };
}

async function ensureNewDirectory(directory) {
  try {
    await fs.access(directory);
  } catch {
    await fs.mkdir(directory, { recursive: true });
    return;
  }
  throw new Error(`Refusing to overwrite conformance output: ${directory}`);
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function sha256File(file) {
  return createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
}

async function writeReport(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
}

function dotnetHostCommand() {
  return process.env.DOTNET_HOST_PATH?.trim() || "dotnet";
}

function optionalFlagValue(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : null;
  return value && !value.startsWith("--") ? value : null;
}

function requiredFlagValue(name) {
  const value = optionalFlagValue(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
