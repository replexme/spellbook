import { readFile, writeFile } from "node:fs/promises";
import { probeEnginePatchVersion } from "./probe-engine-patch.mjs";
import { formatCanonicalDifferences } from "./persistence-evidence.mjs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");
const url = process.argv[2];
const reportPath = process.argv[3];
if (!url || !reportPath)
  throw new Error(
    "Usage: node probe-uno-table-cell-format-reopen.mjs URL REPORT.json",
  );
const expected = JSON.parse(
  await readFile(path.resolve(reportPath), "utf8"),
).persistenceExpected;
if (!expected?.cells?.length)
  throw new Error("The table-cell-format report has no persistence data.");
const persistedCellValues = (cell) => {
  const { propertyStates: _propertyStates, ...values } = cell ?? {};
  return values;
};

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
      body: JSON.stringify({ operation: "observe" }),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
    return value;
  });
  if (probeEnginePatchVersion(observed.engine?.patchLevel) < 6)
    throw new Error(
      `Expected undo-v6 or newer, got ${observed.engine?.patchLevel}.`,
    );
  const table = observed.slides
    .flatMap((slide) => slide.elements)
    .find((element) => element.objectName === expected.objectName);
  const differences = expected.cells.flatMap(({ row, column, cell }) => {
    const actual = table?.table?.cellDetails?.[row]?.[column];
    const cellDifferences = formatCanonicalDifferences(
      persistedCellValues(cell),
      persistedCellValues(actual),
      { path: `$.cells[${row}][${column}]` },
    );
    return cellDifferences.length
      ? [{ row, column, differences: cellDifferences, expected: cell, actual }]
      : [];
  });
  if (differences.length)
    throw new Error(
      `Saved PPTX did not preserve table cell formatting: ${JSON.stringify(differences)}`,
    );
  if (process.env.SPELLBOOK_PROBE_REOPEN_SCREENSHOT) {
    const image = observed.images?.[0];
    if (!image?.pngBytes?.length)
      throw new Error("Reopened document returned no verification image.");
    await writeFile(
      path.resolve(process.env.SPELLBOOK_PROBE_REOPEN_SCREENSHOT),
      Buffer.from(image.pngBytes),
    );
  }
  process.stdout.write(
    `${JSON.stringify({ reopened: true, enginePatchLevel: observed.engine.patchLevel, operation: "set_table_cell_format", objectName: expected.objectName }, null, 2)}\n`,
  );
} finally {
  await browser.close();
}
