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
    "Usage: node probe-uno-table-structure-reopen.mjs URL REPORT.json",
  );
const report = JSON.parse(await readFile(path.resolve(reportPath), "utf8"));
const expected = report.persistenceExpected;
if (!expected?.slides || !expected?.masters || !expected?.objectName)
  throw new Error("The table-structure report has no persistence data.");

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
  const detailSlideIndex = expected.slides.find((slide) =>
    slide.elements?.some(
      (element) => element.objectName === expected.objectName && element.table,
    ),
  )?.slideIndex;
  if (!Number.isInteger(detailSlideIndex))
    throw new Error(
      "The persistence report has no slide for the edited table.",
    );
  const observed = await page.evaluate(async (requestedSlideIndex) => {
    const launch = window.__spellbookLaunch;
    const response = await fetch("/native/probe", {
      method: "POST",
      headers: {
        authorization: `Bearer ${launch.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        operation: "observe",
        detailSlideIndex: requestedSlideIndex,
      }),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
    return value;
  }, detailSlideIndex);
  if (probeEnginePatchVersion(observed.engine?.patchLevel) < 5)
    throw new Error(
      `Expected undo-v5 or newer, got ${observed.engine?.patchLevel}.`,
    );
  const table = observed.slides
    .flatMap((slide) => slide.elements)
    .find((element) => element.objectName === expected.objectName);
  if (!table?.table)
    throw new Error("Reopened PPTX has no expected editable table.");
  if (process.env.SPELLBOOK_PROBE_REOPEN_SCREENSHOT) {
    const image = observed.images?.[0];
    if (!image?.pngBytes?.length)
      throw new Error("Reopened table returned no verification image.");
    await writeFile(
      path.resolve(process.env.SPELLBOOK_PROBE_REOPEN_SCREENSHOT),
      Buffer.from(image.pngBytes),
    );
  }
  const persistenceDifferences = documentPersistenceDeltaDifferences(
    report,
    observed,
  );
  if (persistenceDifferences.length)
    await writeFile(
      path.resolve(path.dirname(reportPath), "reopen-differences.json"),
      `${JSON.stringify(persistenceDifferences, null, 2)}\n`,
    );
  assertDocumentPersistenceDelta(
    report,
    observed,
    "Saved PPTX did not preserve the exact table, slide and master structure.",
  );
  process.stdout.write(
    `${JSON.stringify({ reopened: true, enginePatchLevel: observed.engine.patchLevel, operationCount: 8, objectName: table.objectName, geometry: { x: table.x, y: table.y, width: table.width, height: table.height } }, null, 2)}\n`,
  );
} finally {
  await browser.close();
}
