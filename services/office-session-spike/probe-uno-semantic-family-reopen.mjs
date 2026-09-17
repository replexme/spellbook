import { readFile, writeFile } from "node:fs/promises";
import { probeEnginePatchVersion } from "./probe-engine-patch.mjs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  assertDocumentPersistenceDelta,
  documentPersistenceDeltaDifferences,
} from "./persistence-evidence.mjs";

const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");
const url = process.argv[2];
const reportPath = process.argv[3];
if (!url || !reportPath)
  throw new Error(
    "Usage: node probe-uno-semantic-family-reopen.mjs URL REPORT.json",
  );
const report = JSON.parse(await readFile(path.resolve(reportPath), "utf8"));
if (!report.persistenceExpected?.slides || !report.persistenceExpected?.masters)
  throw new Error("The semantic feature report has no persistence state.");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const deadline = Date.now() + 60_000;
  while (
    !page
      .frames()
      .some((frame) =>
        frame.url().includes("/extensions/org.spellbook.editor/"),
      )
  ) {
    if (Date.now() >= deadline)
      throw new Error("Native editor extension did not connect.");
    await page.waitForTimeout(250);
  }
  const observed = await page.evaluate(async () => {
    const launch = window.__spellbookLaunch;
    const response = await fetch("/native/probe", {
      method: "POST",
      headers: {
        authorization: `Bearer ${launch.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ operation: "observe", captureSlideIndexes: [0] }),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
    return value;
  });
  if (probeEnginePatchVersion(observed.engine?.patchLevel) < 24)
    throw new Error(`Expected undo-v24, got ${observed.engine?.patchLevel}.`);
  const differences = documentPersistenceDeltaDifferences(report, observed);
  if (differences.length)
    await writeFile(
      path.resolve(path.dirname(reportPath), "reopen-differences.json"),
      `${JSON.stringify(differences, null, 2)}\n`,
    );
  if (process.env.SPELLBOOK_PROBE_REOPEN_SCREENSHOT) {
    const image = observed.images?.[0];
    if (!image?.pngBytes?.length)
      throw new Error("Reopened semantic document returned no image.");
    await writeFile(
      path.resolve(process.env.SPELLBOOK_PROBE_REOPEN_SCREENSHOT),
      Buffer.from(image.pngBytes),
    );
  }
  assertDocumentPersistenceDelta(
    report,
    observed,
    "Saved PPTX did not preserve the semantic mutation state.",
  );
  process.stdout.write(
    `${JSON.stringify({ reopened: true, scenario: report.scenario, operations: report.commands, enginePatchLevel: observed.engine.patchLevel }, null, 2)}\n`,
  );
} finally {
  await browser.close();
}
