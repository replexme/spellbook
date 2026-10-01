/* SPDX-License-Identifier: MPL-2.0 */
// One matrix controls both engines. Run with `nice -n 15 node ...`; children
// are sequential and every browser adapter is headless. No native Office app,
// container or cloud resource is launched here.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readRepositoryIdentity } from "./repository-identity.mjs";
import { preserveOriginalPptxParts } from "./ooxml-worker-source.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const flag = (name, fallback) => {
  const i = process.argv.indexOf(name);
  if (i < 0) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing ${name}`);
  }
  return process.argv[i + 1];
};
const manifestPath = path.resolve(flag("--manifest"));
const output = path.resolve(flag("--output"));
const runtime = path.resolve(flag("--native-runtime"));
const candidate = path.resolve(flag("--candidate-root"));
const origin = flag("--origin");
const repairStructure = process.argv.includes("--repair-structure");
const engines = flag("--engines", "native,onlyoffice").split(",");
assert(
  engines.every((e) => ["native", "onlyoffice"].includes(e)) &&
    new Set(engines).size === engines.length,
);
const matrix = JSON.parse(await readFile(manifestPath, "utf8"));
assert(
  Array.isArray(matrix.inputs) && matrix.inputs.length > 0,
  "Nonempty comparison inputs required",
);
const labels = new Set();
for (const input of matrix.inputs) {
  assert(
    /^[a-z0-9-]+$/u.test(input.label) && !labels.has(input.label),
    "Distinct safe labels required",
  );
  labels.add(input.label);
  input.path = path.resolve(path.dirname(manifestPath), input.path);
  assert(
    Array.isArray(input.scenarios) &&
      input.scenarios.length &&
      new Set(input.scenarios).size === input.scenarios.length,
  );
  assert(
    input.scenarios.every((s) =>
      [
        "roundtrip",
        "type",
        "type-move",
        "move",
        "delete",
        "newslide",
        "dupslide",
        "delslide",
      ].includes(s),
    ),
  );
  const bytes = await readFile(input.path);
  input.sha256 = createHash("sha256").update(bytes).digest("hex");
  input.bytes = bytes.length;
  if (input.expectedSha256)
    assert.equal(
      input.sha256,
      input.expectedSha256,
      `${input.label}: source drift`,
    );
}
await mkdir(output, { recursive: false, mode: 0o700 });
const identity = readRepositoryIdentity(root);
assert.equal(
  identity.dirty,
  false,
  "Commit comparison code before recording final evidence",
);
const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  integration: identity,
  candidate: readRepositoryIdentity(candidate),
  engines,
  inputs: matrix.inputs.map(({ path: _, ...input }) => input),
  cases: [],
  scope: {
    native: "product-preserved save and model readback",
    onlyoffice: repairStructure
      ? "browser-repaired export and same-engine model readback; no original-part preservation"
      : "raw export and same-engine model readback",
    visual:
      "screenshots require human inspection; not an automatic fidelity pass",
    powerpoint: "not run: owner-window restriction",
    ai: "typed adapter/native contract evidence, not an authenticated AI provider turn",
  },
};
const tool = path.join(
  root,
  "services/document-worker/tools/Spellbook.Document.Tool/bin/Release/net10.0/Spellbook.Document.Tool.dll",
);
async function run(command, args, log, timeout = 600_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "",
      stderr = "";
    const resources = {
      peakSummedRssKiB: 0,
      peakReportedCpuPercent: 0,
      lowestNice: null,
      sampleCount: 0,
      note: "Sum of task process RSS; shared pages can be counted more than once. ps CPU is a process average, not instantaneous system load.",
    };
    let sampling = false;
    const sample = async () => {
      if (sampling) return;
      sampling = true;
      try {
        const rows = await new Promise((resolve) => {
          const ps = spawn("ps", ["-axo", "pid,ppid,rss,nice,%cpu"], {
            stdio: ["ignore", "pipe", "ignore"],
          });
          let data = "";
          ps.stdout.on("data", (d) => (data += d));
          ps.on("error", () => resolve([]));
          ps.on("close", () =>
            resolve(
              data
                .trim()
                .split("\n")
                .slice(1)
                .map((line) => line.trim().split(/\s+/u).map(Number)),
            ),
          );
        });
        const owned = new Set([child.pid]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const [pid, ppid] of rows)
            if (owned.has(ppid) && !owned.has(pid)) {
              owned.add(pid);
              changed = true;
            }
        }
        const selected = rows.filter(([pid]) => owned.has(pid));
        if (selected.length) {
          resources.sampleCount++;
          resources.peakSummedRssKiB = Math.max(
            resources.peakSummedRssKiB,
            selected.reduce((sum, row) => sum + row[2], 0),
          );
          resources.peakReportedCpuPercent = Math.max(
            resources.peakReportedCpuPercent,
            selected.reduce((sum, row) => sum + row[4], 0),
          );
          resources.lowestNice = Math.min(
            resources.lowestNice ?? Infinity,
            ...selected.map((row) => row[3]),
          );
        }
      } finally {
        sampling = false;
      }
    };
    const resourceTimer = setInterval(() => void sample(), 2_000);
    void sample();
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    }, timeout);
    child.on("error", (e) => {
      clearTimeout(timer);
      clearInterval(resourceTimer);
      reject(e);
    });
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      clearInterval(resourceTimer);
      await writeFile(log, stdout + stderr, { mode: 0o600 });
      resolve({ code, signal, stdout, stderr, resources });
    });
  });
}
async function validation(input, log) {
  const result = await run(
    "dotnet",
    [tool, "validate-openxml", input],
    log,
    60_000,
  );
  try {
    return JSON.parse(result.stdout);
  } catch {
    return {
      Valid: false,
      validatorFailed: true,
      error: result.stderr.slice(0, 1000),
    };
  }
}
try {
  for (const input of matrix.inputs) {
    const dir = path.join(output, input.label);
    await mkdir(dir, { mode: 0o700 });
    const originalValidation = await validation(
      input.path,
      path.join(dir, "original-openxml.log"),
    );
    for (const engine of engines) {
      const engineDir = path.join(dir, engine);
      await mkdir(engineDir, { mode: 0o700 });
      if (engine === "onlyoffice") {
        const process = await run(
          "node",
          [
            path.join(import.meta.dirname, "verify-onlyoffice-comparison.mjs"),
            "--input",
            input.path,
            "--output",
            engineDir,
            "--candidate-root",
            candidate,
            "--origin",
            origin,
            "--scenarios",
            input.scenarios.join(","),
            ...(repairStructure ? ["--repair-structure"] : []),
          ],
          path.join(engineDir, "process.log"),
        );
        let result;
        try {
          result = JSON.parse(
            await readFile(path.join(engineDir, "report.json"), "utf8"),
          );
        } catch {
          report.cases.push({
            label: input.label,
            engine,
            status: "process-failed",
            code: process.code,
          });
          continue;
        }
        for (const cell of result.cases) {
          const saved = path.join(engineDir, `${cell.scenario}.pptx`);
          const sdk = cell.savedSha256
            ? await validation(
                saved,
                path.join(engineDir, `${cell.scenario}-openxml.log`),
              )
            : null;
          let preservationTrial = null;
          if (
            cell.savedSha256 &&
            cell.scenario !== "roundtrip" &&
            input.scenarios.includes("roundtrip")
          ) {
            try {
              const original = new Uint8Array(await readFile(input.path));
              const noEdit = new Uint8Array(
                await readFile(path.join(engineDir, "roundtrip.pptx")),
              );
              const edited = new Uint8Array(await readFile(saved));
              const op = {
                type: "replace_text",
                move: "move",
                delete: "delete_element",
              }[cell.scenario];
              const operations =
                cell.scenario === "type-move"
                  ? ["replace_text", "move"]
                  : op
                    ? [op]
                    : null;
              const targets =
                operations && cell.setup?.name
                  ? operations.map((op) => ({
                      op,
                      slideIndex: 0,
                      name: cell.setup.name,
                      shapeIndex: cell.setup.index,
                    }))
                  : null;
              const trial = preserveOriginalPptxParts(
                original,
                noEdit,
                edited,
                operations,
                targets,
              );
              const trialPath = path.join(
                engineDir,
                `${cell.scenario}-preservation-trial.pptx`,
              );
              await writeFile(trialPath, trial.bytes, { mode: 0o600 });
              preservationTrial = {
                status: "package-produced-not-engine-admitted",
                report: trial.report,
                openXml: await validation(
                  trialPath,
                  path.join(
                    engineDir,
                    `${cell.scenario}-preservation-trial-openxml.log`,
                  ),
                ),
                proofLimit:
                  "Package-only trial; requires candidate-engine reopen and complete intent readback before use",
              };
            } catch (error) {
              preservationTrial = { status: "refused", error: error.message };
            }
          }
          report.cases.push({
            label: input.label,
            engine,
            ...cell,
            originalOpenXml: originalValidation,
            savedOpenXml: sdk,
            preservationTrial,
            runResources: process.resources,
          });
        }
      } else
        for (const scenario of input.scenarios) {
          const caseDir = path.join(engineDir, scenario);
          await mkdir(caseDir, { mode: 0o700 });
          const receipt = path.join(caseDir, "receipt.json"),
            saved = path.join(caseDir, "saved.pptx");
          const process = await run(
            "node",
            [
              path.join(import.meta.dirname, "verify-human-edits.mjs"),
              "--input",
              input.path,
              "--runtime",
              runtime,
              "--label",
              input.label,
              "--scenario",
              scenario,
              "--receipt",
              receipt,
              "--saved-output",
              saved,
              "--capture-ui",
              path.join(caseDir, "ui"),
            ],
            path.join(caseDir, "process.log"),
          );
          let result;
          try {
            result = JSON.parse(await readFile(receipt, "utf8"));
          } catch {
            result = { outcome: "process-failed", code: process.code };
          }
          const sdk =
            result.outcome === "saved"
              ? await validation(saved, path.join(caseDir, "openxml.log"))
              : null;
          report.cases.push({
            label: input.label,
            engine,
            ...result,
            originalOpenXml: originalValidation,
            savedOpenXml: sdk,
            runResources: process.resources,
          });
          await writeFile(
            path.join(output, "report.json"),
            JSON.stringify(report, null, 2) + "\n",
          );
          console.log(
            JSON.stringify({
              label: input.label,
              engine,
              scenario,
              outcome: result.outcome,
              error: result.error,
            }),
          );
        }
      await writeFile(
        path.join(output, "report.json"),
        JSON.stringify(report, null, 2) + "\n",
      );
      if (engine === "onlyoffice")
        console.log(
          JSON.stringify({
            label: input.label,
            engine,
            completedCases: input.scenarios.length,
          }),
        );
    }
  }
} finally {
  report.finishedAt = new Date().toISOString();
  report.finalIntegration = readRepositoryIdentity(root);
  report.sourceStable =
    JSON.stringify(report.finalIntegration) === JSON.stringify(identity);
  report.summary = {
    cases: report.cases.length,
    nativeSaved: report.cases.filter(
      (c) => c.engine === "native" && c.outcome === "saved" && !c.note,
    ).length,
    onlyofficeRawVerified: report.cases.filter(
      (c) =>
        c.engine === "onlyoffice" && c.status === "raw-export-reopen-verified",
    ).length,
    refused: report.cases.filter((c) => c.outcome === "refused").length,
    errors: report.cases.filter(
      (c) =>
        c.outcome === "error" ||
        c.status === "failed" ||
        c.outcome === "process-failed" ||
        c.status === "process-failed",
    ).length,
  };
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
}
assert(
  report.sourceStable,
  "Integration changed while comparison was running; evidence invalidated",
);
