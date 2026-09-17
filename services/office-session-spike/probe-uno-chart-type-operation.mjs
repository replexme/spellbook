import { createRequire } from "node:module";
import { requestNativeProbeSave } from "./probe-save.mjs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");
const url = process.argv[2] ?? "http://localhost:3190";
const reportPath = process.argv[3] ? path.resolve(process.argv[3]) : null;
const requestedType = process.argv[4] ?? "line";
const observedTypes = {
  column: "com.sun.star.chart2.ColumnChartType",
  line: "com.sun.star.chart2.LineChartType",
  area: "com.sun.star.chart2.AreaChartType",
  pie: "com.sun.star.chart2.PieChartType",
  scatter: "com.sun.star.chart2.ScatterChartType",
  radar: "com.sun.star.chart2.NetChartType",
};
const expectedObservedType = observedTypes[requestedType];
if (!expectedObservedType)
  throw new Error(`Unsupported probe chart type: ${requestedType}`);
const browser = await chromium.launch({ headless: true });
const seriesState = (chart) =>
  chart.chartTypes.flatMap((chartType) =>
    chartType.series.map((series, seriesIndex) => {
      const ySequence =
        series.sequences.find((sequence) => sequence.role === "values-y") ??
        series.sequences.find((sequence) => sequence.role === "values");
      const xSequence = series.sequences.find(
        (sequence) => sequence.role === "values-x",
      );
      const yColumn = Number(ySequence?.sourceRange);
      const xColumn = Number(xSequence?.sourceRange);
      return {
        label:
          ySequence?.label?.[0] ??
          chart.columnDescriptions[yColumn] ??
          `Series ${seriesIndex + 1}`,
        values: chart.data.map((row) => row[yColumn] ?? null),
        xValues: Number.isInteger(xColumn)
          ? chart.data.map((row) => row[xColumn] ?? null)
          : null,
      };
    }),
  );

try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const extensionDeadline = Date.now() + 60_000;
  while (
    !page
      .frames()
      .some((frame) =>
        frame.url().includes("/extensions/org.spellbook.editor/"),
      )
  ) {
    if (Date.now() >= extensionDeadline)
      throw new Error("Native editor extension did not connect.");
    await page.waitForTimeout(250);
  }
  const call = (request) =>
    page.evaluate(async (input) => {
      const response = await fetch("/native/probe", {
        method: "POST",
        headers: {
          authorization: `Bearer ${window.__spellbookLaunch.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      });
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error ?? `HTTP ${response.status}`);
      return value;
    }, request);
  const history = (direction) => {
    const extensionFrame = page
      .frames()
      .find((frame) =>
        frame.url().includes("/extensions/org.spellbook.editor/"),
      );
    if (!extensionFrame) throw new Error("Native extension frame was lost.");
    return extensionFrame.evaluate(
      (requestedDirection) =>
        cool.callRemote(function presentChartTypeHistory(value) {
          const undo = uno.idl.com.sun.star.frame.Desktop.create(
            uno.componentContext,
          )
            .getCurrentFrame()
            .getController()
            .getModel()
            .getUndoManager();
          if (value === "undo") undo.undo();
          else if (value === "redo") undo.redo();
          else throw new Error("invalid_history_direction");
        }, requestedDirection),
      direction,
    );
  };
  const waitFor = async (expected, label) => {
    const deadline = Date.now() + 10_000;
    let current;
    do {
      current = await call({ operation: "observe" });
      if (
        current.revision === expected.revision &&
        JSON.stringify(current.slides) === JSON.stringify(expected.slides) &&
        JSON.stringify(current.masters) === JSON.stringify(expected.masters)
      )
        return current;
      await page.waitForTimeout(100);
    } while (Date.now() < deadline);
    throw new Error(`${label} did not restore the exact presentation.`);
  };

  const before = await call({ operation: "observe" });
  const target = before.slides
    .flatMap((slide) => slide.elements)
    .find(
      (element) =>
        element.parentElementId === null &&
        element.chart?.internalData &&
        element.chart.chartTypes.length === 1 &&
        element.chart.chartTypes[0].type !== expectedObservedType,
    );
  if (!target) throw new Error("No convertible internal-data chart was found.");
  let unsafeBatchError = null;
  try {
    await call({
      operation: "edit_batch",
      expectedRevision: before.revision,
      expectedSlides: JSON.stringify(before.slides),
      commands: [
        {
          op: "set_chart_type",
          elementId: target.elementId,
          chartType: requestedType,
        },
        { op: "move", elementId: target.elementId, x: target.x, y: target.y },
      ],
      permission: { mode: "document", slideIndexes: [], elementIds: [] },
    });
  } catch (error) {
    unsafeBatchError = error.message;
  }
  if (
    !unsafeBatchError?.includes("identity_replacing_operation_must_be_isolated")
  )
    throw new Error(
      `Unsafe chart-type batch was not rejected: ${unsafeBatchError}`,
    );
  await waitFor(before, "Rejected chart-type batch");

  const after = await call({
    operation: "edit_batch",
    expectedRevision: before.revision,
    expectedSlides: JSON.stringify(before.slides),
    commands: [
      {
        op: "set_chart_type",
        elementId: target.elementId,
        chartType: requestedType,
      },
    ],
    permission: { mode: "document", slideIndexes: [], elementIds: [] },
  });
  const afterTarget = after.slides
    .flatMap((slide) => slide.elements)
    .find((element) => element.stableId === target.stableId);
  const beforeSeries = seriesState(target.chart);
  const afterSeries = afterTarget?.chart
    ? seriesState(afterTarget.chart)
    : null;
  const seriesPreserved =
    afterSeries?.length === beforeSeries.length &&
    afterSeries.every(
      (series, seriesIndex) =>
        series.label === beforeSeries[seriesIndex].label &&
        JSON.stringify(series.values) ===
          JSON.stringify(beforeSeries[seriesIndex].values) &&
        (requestedType !== "scatter" ||
          JSON.stringify(series.xValues) ===
            JSON.stringify(
              beforeSeries[seriesIndex].xValues ??
                target.chart.rowDescriptions.map((label, rowIndex) => {
                  const numericLabel = Number(label);
                  return Number.isFinite(numericLabel)
                    ? numericLabel
                    : rowIndex + 1;
                }),
            )),
    );
  if (
    afterTarget?.chart?.chartTypes.length !== 1 ||
    afterTarget.chart.chartTypes[0].type !== expectedObservedType ||
    !seriesPreserved ||
    after.transaction?.commandCount !== 1 ||
    after.transaction?.undoActionsAdded !== 1
  )
    throw new Error("Chart-type operation did not apply exactly.");

  await history("undo");
  await waitFor(before, "Chart-type Undo");
  await history("redo");
  const redone = await waitFor(after, "Chart-type Redo");
  await page.waitForTimeout(1_000);
  await waitFor(after, "Settled chart-type Redo");
  await requestNativeProbeSave(page);

  const report = {
    enginePatchLevel: redone.engine?.patchLevel,
    operation: "set_chart_type",
    targetChartType: requestedType,
    unsafeBatchRejected: true,
    undoExact: true,
    redoExact: true,
    expected: {
      masterCount: redone.masters.length,
      target: {
        stableId: afterTarget.stableId,
        objectName: afterTarget.objectName,
        zIndex: afterTarget.zIndex,
        x: afterTarget.x,
        y: afterTarget.y,
        width: afterTarget.width,
        height: afterTarget.height,
        chart: afterTarget.chart,
      },
    },
    save: { acknowledged: true },
  };
  if (reportPath)
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx",
    });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await browser.close();
}
