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
  const call = (request) =>
    page.evaluate(async (input) => {
      const launch = window.__spellbookLaunch;
      const response = await fetch("/native/probe", {
        method: "POST",
        headers: {
          authorization: `Bearer ${launch.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      });
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error ?? `HTTP ${response.status}`);
      return value;
    }, request);
  const dispatchHistory = (direction) => {
    const frame = page
      .frames()
      .find((candidate) =>
        candidate.url().includes("/extensions/org.spellbook.editor/"),
      );
    if (!frame) throw new Error("Native extension frame was lost.");
    return frame.evaluate(
      (remoteDirection) =>
        cool.callRemote(function presentChartProbeHistory(value) {
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
          return {
            undo: undo.getAllUndoActionTitles(),
            redo: undo.getAllRedoActionTitles(),
          };
        }, remoteDirection),
      direction,
    );
  };
  const firstDifference = (left, right, currentPath = "document") => {
    if (Object.is(left, right)) return null;
    if (
      !left ||
      !right ||
      typeof left !== "object" ||
      typeof right !== "object"
    )
      return { path: currentPath, expected: left, actual: right };
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      const difference = firstDifference(
        left[key],
        right[key],
        `${currentPath}.${key}`,
      );
      if (difference) return difference;
    }
    return null;
  };
  const waitForRevision = async (revision, expected, label) => {
    const stop = Date.now() + 10_000;
    let current;
    do {
      current = await call({ operation: "observe" });
      if (current.revision === revision) {
        if (
          JSON.stringify(current.slides) !== JSON.stringify(expected.slides) ||
          JSON.stringify(current.masters) !== JSON.stringify(expected.masters)
        )
          throw new Error(`${label} revision matched but structure differed.`);
        return current;
      }
      await page.waitForTimeout(100);
    } while (Date.now() < stop);
    throw new Error(
      `${label} did not restore the expected revision: ${JSON.stringify({ expectedRevision: revision, actualRevision: current?.revision, difference: firstDifference({ slides: expected.slides, masters: expected.masters }, { slides: current?.slides, masters: current?.masters }) })}`,
    );
  };

  const before = await call({ operation: "observe" });
  const target = before.slides
    .flatMap((slide) => slide.elements)
    .find(
      (element) =>
        element.parentElementId === null && element.chart?.internalData,
    );
  if (!target) throw new Error("No internal-data chart in the probe deck.");
  const data = target.chart.data.map((row) => [...row]);
  let changed = false;
  for (const row of data) {
    const column = row.findIndex((value) => typeof value === "number");
    if (column >= 0) {
      row[column] += 1;
      changed = true;
      break;
    }
  }
  if (!changed) throw new Error("Chart fixture has no editable numeric value.");
  const rowDescriptions = [...target.chart.rowDescriptions];
  const columnDescriptions = [...target.chart.columnDescriptions];
  if (!rowDescriptions.length || !columnDescriptions.length)
    throw new Error("Chart fixture has no editable labels.");
  rowDescriptions[0] = `${rowDescriptions[0]} edited`;
  columnDescriptions[0] = `${columnDescriptions[0]} edited`;

  let multiCommandBatchError = null;
  try {
    await call({
      operation: "edit_batch",
      expectedRevision: before.revision,
      expectedSlides: JSON.stringify(before.slides),
      commands: [
        {
          op: "set_chart_data",
          elementId: target.elementId,
          data,
          rowDescriptions,
          columnDescriptions,
        },
        {
          op: "move",
          elementId: target.elementId,
          x: target.x,
          y: target.y,
        },
      ],
      dryRun: false,
      permission: { mode: "document", slideIndexes: [], elementIds: [] },
    });
  } catch (error) {
    multiCommandBatchError = error.message;
  }
  if (
    !multiCommandBatchError?.includes(
      "identity_replacing_operation_must_be_isolated",
    )
  )
    throw new Error(
      `Identity-replacing chart batch was not rejected safely: ${multiCommandBatchError}`,
    );
  const afterRejectedBatch = await call({ operation: "observe" });
  if (
    afterRejectedBatch.revision !== before.revision ||
    JSON.stringify(afterRejectedBatch.slides) !==
      JSON.stringify(before.slides) ||
    JSON.stringify(afterRejectedBatch.masters) !==
      JSON.stringify(before.masters)
  )
    throw new Error("Rejected chart batch changed the presentation.");

  const after = await call({
    operation: "edit_batch",
    expectedRevision: before.revision,
    expectedSlides: JSON.stringify(before.slides),
    commands: [
      {
        op: "set_chart_data",
        elementId: target.elementId,
        data,
        rowDescriptions,
        columnDescriptions,
      },
    ],
    dryRun: false,
    permission: { mode: "document", slideIndexes: [], elementIds: [] },
  });
  const afterTarget = after.slides
    .flatMap((slide) => slide.elements)
    .find((element) => element.stableId === target.stableId);
  if (
    !afterTarget ||
    JSON.stringify(afterTarget.chart?.data) !== JSON.stringify(data) ||
    JSON.stringify(afterTarget.chart?.rowDescriptions) !==
      JSON.stringify(rowDescriptions) ||
    JSON.stringify(afterTarget.chart?.columnDescriptions) !==
      JSON.stringify(columnDescriptions) ||
    after.revision === before.revision ||
    after.transaction?.status !== "applied" ||
    after.transaction?.commandCount !== 1 ||
    after.transaction?.undoActionsAdded !== 1
  )
    throw new Error("Chart data operation did not apply exactly.");

  await dispatchHistory("undo");
  await waitForRevision(before.revision, before, "Chart operation Undo");
  await dispatchHistory("redo");
  const chartDataRedone = await waitForRevision(
    after.revision,
    after,
    "Chart operation Redo",
  );
  await page.waitForTimeout(1_000);
  await waitForRevision(after.revision, after, "Settled chart operation");

  const chartDataTarget = chartDataRedone.slides
    .flatMap((slide) => slide.elements)
    .find((element) => element.stableId === target.stableId);
  if (!chartDataTarget?.chart?.format)
    throw new Error("Chart format was not observable after the data edit.");
  const previousFormat = chartDataTarget.chart.format;
  const chartFormat = {
    title: previousFormat.title
      ? `${previousFormat.title} formatted`
      : "Spellbook chart",
    legendVisible: true,
    legendPosition: previousFormat.legendPosition === "left" ? "right" : "left",
    categoryAxisVisible: !previousFormat.categoryAxisVisible,
    valueAxisVisible: !previousFormat.valueAxisVisible,
    showValues: !previousFormat.series.every(
      (series) => series.label?.showValues,
    ),
    showCategoryNames: !previousFormat.series.every(
      (series) => series.label?.showCategoryNames,
    ),
    showSeriesNames: !previousFormat.series.every(
      (series) => series.label?.showSeriesNames,
    ),
    seriesColors: previousFormat.series.map(
      (series, index) =>
        ((Number.isInteger(series.color) ? series.color : index * 0x224466) ^
          0x010101) &
        0xffffff,
    ),
  };
  const afterFormat = await call({
    operation: "edit_batch",
    expectedRevision: chartDataRedone.revision,
    expectedSlides: JSON.stringify(chartDataRedone.slides),
    commands: [
      {
        op: "set_chart_format",
        elementId: chartDataTarget.elementId,
        chartFormat,
      },
    ],
    dryRun: false,
    permission: { mode: "document", slideIndexes: [], elementIds: [] },
  });
  const formattedTarget = afterFormat.slides
    .flatMap((slide) => slide.elements)
    .find((element) => element.stableId === target.stableId);
  const expectedSeries = chartFormat.seriesColors.map((color) => ({ color }));
  if (
    !formattedTarget?.chart?.format ||
    formattedTarget.chart.format.title !== chartFormat.title ||
    formattedTarget.chart.format.legendVisible !== chartFormat.legendVisible ||
    formattedTarget.chart.format.legendPosition !==
      chartFormat.legendPosition ||
    formattedTarget.chart.format.categoryAxisVisible !==
      chartFormat.categoryAxisVisible ||
    formattedTarget.chart.format.valueAxisVisible !==
      chartFormat.valueAxisVisible ||
    formattedTarget.chart.format.series.length !== expectedSeries.length ||
    formattedTarget.chart.format.series.some(
      (series, index) =>
        series.color !== expectedSeries[index].color ||
        series.label?.showValues !== chartFormat.showValues ||
        series.label?.showCategoryNames !== chartFormat.showCategoryNames ||
        series.label?.showSeriesNames !== chartFormat.showSeriesNames,
    ) ||
    afterFormat.transaction?.status !== "applied" ||
    afterFormat.transaction?.commandCount !== 1 ||
    afterFormat.transaction?.undoActionsAdded !== 1
  )
    throw new Error("Chart format operation did not apply exactly.");

  await dispatchHistory("undo");
  await waitForRevision(
    chartDataRedone.revision,
    chartDataRedone,
    "Chart format Undo",
  );
  await dispatchHistory("redo");
  const redone = await waitForRevision(
    afterFormat.revision,
    afterFormat,
    "Chart format Redo",
  );

  await requestNativeProbeSave(page);
  const report = {
    enginePatchLevel: redone.engine?.patchLevel,
    commands: ["set_chart_data", "set_chart_format"],
    multiCommandBatchRejected: true,
    singleCommandBatchAtomic: true,
    undoExact: true,
    redoExact: true,
    expected: {
      masterCount: redone.masters.length,
      target: {
        stableId: formattedTarget.stableId,
        objectName: formattedTarget.objectName,
        zIndex: formattedTarget.zIndex,
        x: formattedTarget.x,
        y: formattedTarget.y,
        width: formattedTarget.width,
        height: formattedTarget.height,
        chart: formattedTarget.chart,
      },
    },
  };
  if (reportPath)
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx",
    });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await browser.close();
}
