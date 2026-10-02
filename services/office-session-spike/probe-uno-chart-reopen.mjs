import { closeNativeProbe } from "./probe-raw-snapshots.mjs";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");
const url = process.argv[2];
const reportPath = process.argv[3];
if (!url || !reportPath)
  throw new Error("Usage: node probe-uno-chart-reopen.mjs URL REPORT.json");
const report = JSON.parse(await readFile(reportPath, "utf8"));
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
  const target = observed.slides
    .flatMap((slide) => slide.elements)
    .find(
      (element) =>
        element.objectName === report.expected.target.objectName &&
        element.chart?.internalData,
    );
  if (!target) throw new Error("Reopened PPTX has no expected internal chart.");
  const actual = {
    stableId: target.stableId,
    objectName: target.objectName,
    zIndex: target.zIndex,
    x: target.x,
    y: target.y,
    width: target.width,
    height: target.height,
    chart: target.chart,
  };
  const geometryToleranceHundredthMillimeter = 1;
  const roundTripGeometryDelta = {
    width: actual.width - report.expected.target.width,
    height: actual.height - report.expected.target.height,
  };
  const differences = [];
  for (const key of Object.keys(report.expected.target)) {
    const isQuantizedDimension = ["width", "height"].includes(key);
    const differs = isQuantizedDimension
      ? Math.abs(actual[key] - report.expected.target[key]) >
        geometryToleranceHundredthMillimeter
      : JSON.stringify(actual[key]) !==
        JSON.stringify(report.expected.target[key]);
    if (differs)
      differences.push({
        key,
        expected: report.expected.target[key],
        actual: actual[key],
      });
  }
  if (observed.masters.length !== report.expected.masterCount)
    differences.push({
      key: "masterCount",
      expected: report.expected.masterCount,
      actual: observed.masters.length,
    });
  if (differences.length)
    throw new Error(
      `Reopened chart differs from the saved candidate: ${JSON.stringify(differences)}`,
    );
  if (process.env.SPELLBOOK_PROBE_REOPEN_SCREENSHOT) {
    const image = observed.images?.[0];
    if (!image?.pngBytes?.length)
      throw new Error("Reopened chart did not return a verification image.");
    await writeFile(
      path.resolve(process.env.SPELLBOOK_PROBE_REOPEN_SCREENSHOT),
      Buffer.from(image.pngBytes),
    );
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        reopened: true,
        enginePatchLevel: observed.engine?.patchLevel,
        masterCount: observed.masters.length,
        chartTypeCount: target.chart.chartTypes.length,
        seriesCount: target.chart.chartTypes.reduce(
          (total, type) => total + type.series.length,
          0,
        ),
        rowCount: target.chart.rowCount,
        columnCount: target.chart.columnCount,
        objectName: target.objectName,
        roundTripGeometryDelta,
        geometryToleranceHundredthMillimeter,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await closeNativeProbe(browser, "uno-chart-reopen");
}
