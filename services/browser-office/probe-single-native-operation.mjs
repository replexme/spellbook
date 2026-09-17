/* SPDX-License-Identifier: MPL-2.0 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { chromium } from "@playwright/test";

import { admitCandidateRuntime } from "./candidate-runtime.mjs";
import { createHarnessServer } from "./server.mjs";

const option = (name) => {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1])
    throw new Error(`Missing ${name}.`);
  return process.argv[index + 1];
};
const candidateRuntime = await admitCandidateRuntime({
  runtimeDirectory: path.resolve(option("--candidate-runtime")),
});
const source = path.resolve(option("--source"));
const operation = option("--operation");
const index = Number(option("--index"));
const count = Number(option("--count"));
const priorRow = process.argv.includes("--prior-row");
const priorHistory = process.argv.includes("--prior-history");
if (priorHistory && !priorRow)
  throw new Error("--prior-history requires --prior-row.");
if (
  !["insert_table_rows", "insert_table_columns"].includes(operation) ||
  !Number.isSafeInteger(index) ||
  !Number.isSafeInteger(count)
)
  throw new Error("The diagnostic operation is invalid.");
await readFile(source);

const server = createHarnessServer({
  runtimeRoot: candidateRuntime.runtimeDirectory,
  runtimeIdentity: candidateRuntime.runtimeIdentity,
  upstream: candidateRuntime.upstream,
  browserProbeSource: source,
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.goto(
    `${origin}/workspace?hostOrigin=${encodeURIComponent(origin)}&browserProbe=1`,
    { waitUntil: "domcontentloaded" },
  );
  await page.waitForFunction(() => Boolean(window.__spellbookLaunch), null, {
    timeout: 60_000,
  });
  const call = (input) =>
    page.evaluate(async (request) => {
      const response = await fetch("/native/probe", {
        method: "POST",
        headers: {
          authorization: `Bearer ${window.__spellbookLaunch.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
      });
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error ?? `HTTP ${response.status}`);
      return value;
    }, input);
  let observed = await call({ operation: "observe" });
  const table = observed.slides
    .flatMap((slide) => slide.elements)
    .find((element) => element.table);
  if (!table) throw new Error("No table was found in the source deck.");
  const edit = (before, command) =>
    call({
      operation: "edit",
      expectedRevision: before.revision,
      expectedSlides: JSON.stringify(before.slides),
      permission: { mode: "document", slideIndexes: [], elementIds: [] },
      command: { elementId: table.elementId, ...command },
      diagnosticTimings: true,
    });
  if (priorRow) {
    observed = await edit(observed, {
      op: "insert_table_rows",
      index: 1,
      count: 1,
    });
    if (priorHistory) {
      const frame = page
        .frames()
        .find((candidate) =>
          candidate.url().includes("/extensions/org.spellbook.editor/"),
        );
      if (!frame) throw new Error("Native extension frame was not found.");
      for (const direction of ["undo", "redo"]) {
        await frame.evaluate(
          (requestedDirection) =>
            cool.callRemote(function tableHistory(historyDirection) {
              const desktop = uno.idl.com.sun.star.frame.Desktop.create(
                uno.componentContext,
              );
              const manager = desktop
                .getCurrentFrame()
                .getController()
                .getModel()
                .getUndoManager();
              manager[historyDirection]();
            }, requestedDirection),
          direction,
        );
        observed = await call({ operation: "observe" });
      }
    }
  }
  const started = Date.now();
  const after = await edit(observed, { op: operation, index, count });
  const diagnostics = await page.evaluate(() =>
    globalThis.spellbookBrowserOffice.diagnostics(),
  );
  const phaseDurationsMs = diagnostics.browserProbePhaseTrace
    ?.slice(1)
    .map((entry, position) => ({
      phase: entry.phase,
      elapsedMs: entry.at - diagnostics.browserProbePhaseTrace[position].at,
    }));
  const currentTable = (state) =>
    state.slides
      .flatMap((slide) => slide.elements)
      .find((element) => element.elementId === table.elementId)?.table;
  const dimensions = (state) => ({
    rows: currentTable(state)?.rows,
    columns: currentTable(state)?.columns,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        operation,
        priorRow,
        priorHistory,
        elapsedMs: Date.now() - started,
        phaseDurationsMs,
        nativeTimings: after.nativeTimings,
        before: dimensions(observed),
        after: dimensions(after),
        changedSlideIndexes: after.changedSlideIndexes,
        visualEvidenceComplete: after.visualEvidenceComplete,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
