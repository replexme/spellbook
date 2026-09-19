import { createRequire } from "node:module";
import { probeEnginePatchVersion } from "./probe-engine-patch.mjs";
import { requestNativeProbeSave } from "./probe-save.mjs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  historyStateDifference,
  historyStateEquivalent,
} from "./persistence-evidence.mjs";
import { captureNativeSnapshots } from "./probe-raw-snapshots.mjs";

const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");
const url = process.argv[2] ?? "http://localhost:3190";
const reportPath = process.argv[3] ? path.resolve(process.argv[3]) : null;
const browser = await chromium.launch({ headless: true });
let page;

const stable = (value) => JSON.stringify(value);
const cellComparable = (cell) => {
  const { propertyStates: _propertyStates, ...persistedValues } = cell ?? {};
  return persistedValues;
};

try {
  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  if (process.env.SPELLBOOK_PROBE_OPERATIONS_JS_PATH) {
    const operations = (
      await readFile(
        path.resolve(process.env.SPELLBOOK_PROBE_OPERATIONS_JS_PATH),
        "utf8",
      )
    ).replace(
      "__SPELLBOOK_ENGINE_PATCH_LEVEL__",
      process.env.SPELLBOOK_PROBE_ENGINE_PATCH_LEVEL ?? "undo-v0",
    );
    await page.route(
      "**/extensions/org.spellbook.editor/operations.js",
      (route) =>
        route.fulfill({
          body: operations,
          contentType: "text/javascript; charset=utf-8",
        }),
    );
  }
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
  const history = (direction = null) => {
    const frame = page
      .frames()
      .find((candidate) =>
        candidate.url().includes("/extensions/org.spellbook.editor/"),
      );
    if (!frame) throw new Error("Native extension frame was lost.");
    return frame.evaluate(
      (requestedDirection) =>
        cool.callRemote(function spellbookTableCellFormatHistory(value) {
          const undo = uno.idl.com.sun.star.frame.Desktop.create(
            uno.componentContext,
          )
            .getCurrentFrame()
            .getController()
            .getModel()
            .getUndoManager();
          if (value === "undo") undo.undo();
          else if (value === "redo") undo.redo();
          else if (value !== null) throw new Error("invalid_history_direction");
          return {
            undo: undo.getAllUndoActionTitles(),
            redo: undo.getAllRedoActionTitles(),
          };
        }, requestedDirection),
      direction,
    );
  };
  const waitForState = async (expected, label) => {
    const stop = Date.now() + 10_000;
    let observed;
    do {
      observed = await call({ operation: "observe" });
      if (historyStateEquivalent(expected, observed)) return observed;
      await page.waitForTimeout(100);
    } while (Date.now() < stop);
    throw new Error(
      `${label} did not restore the exact document: ${JSON.stringify(
        historyStateDifference(expected, observed),
      )}`,
    );
  };

  const before = await call({ operation: "observe" });
  if (probeEnginePatchVersion(before.engine?.patchLevel) < 6)
    throw new Error("The table-cell-format engine candidate is unavailable.");
  let target = null;
  let targetRow = -1;
  let targetColumn = -1;
  for (const element of before.slides.flatMap((slide) => slide.elements)) {
    if (element.parentElementId !== null || !element.table?.cellDetails)
      continue;
    for (let row = 0; row < element.table.cellDetails.length; row += 1) {
      const cells = element.table.cellDetails[row];
      for (let column = 0; column + 1 < cells.length; column += 1) {
        if (
          String(element.table.cells?.[row]?.[column] ?? "").trim() &&
          String(element.table.cells?.[row]?.[column + 1] ?? "").trim()
        ) {
          target = element;
          targetRow = row;
          targetColumn = column;
          break;
        }
      }
      if (target) break;
    }
    if (target) break;
  }
  if (!target)
    throw new Error("No adjacent non-empty editable table cells were found.");
  const beforeCell = target.table.cellDetails[targetRow][targetColumn];
  if (
    !beforeCell.borders?.top ||
    !beforeCell.borders?.right ||
    !beforeCell.borders?.bottom ||
    !beforeCell.borders?.left
  )
    throw new Error("The target table cell has no observable borders.");
  const pointSpacing = beforeCell.characterSpacing === 2 ? 1.5 : 2;
  const alignment =
    Number(beforeCell.paragraphAlignment) === 3 ? "right" : "center";
  const requestedBorder = (edge, width) => ({
    color: edge.color === 16711935 ? 65535 : 16711935,
    width,
  });
  const format = {
    fillColor: beforeCell.fillColor === 65280 ? 255 : 65280,
    fillOpacity: beforeCell.fillOpacity === 73 ? 74 : 73,
    fontColor: beforeCell.color === 16711680 ? 255 : 16711680,
    fontSize: beforeCell.fontSize === 22 ? 21 : 22,
    // Use fonts physically present in the candidate image. Liberation's
    // PowerPoint compatibility aliases can legitimately serialize as Arial,
    // which makes it a bad persistence oracle for the actual table mutation.
    fontFamily:
      beforeCell.fontFamily === "Noto Sans CJK KR"
        ? "Noto Serif CJK KR"
        : "Noto Sans CJK KR",
    bold: Number(beforeCell.fontWeight) < 150,
    underline: Number(beforeCell.underline) !== 1,
    strikethrough: Number(beforeCell.strikethrough) !== 1,
    textShadow: !beforeCell.textShadow,
    characterSpacing: pointSpacing,
    paragraphAlignment: alignment,
    marginLeft: Number(beforeCell.textMargins.left) + 11,
    marginRight: Number(beforeCell.textMargins.right) + 12,
    marginTop: Number(beforeCell.textMargins.top) + 13,
    marginBottom: Number(beforeCell.textMargins.bottom) + 14,
    borderTop: requestedBorder(beforeCell.borders.top, 1),
    borderRight: requestedBorder(beforeCell.borders.right, 1.25),
    borderBottom: requestedBorder(beforeCell.borders.bottom, 1.5),
    borderLeft: requestedBorder(beforeCell.borders.left, 1.75),
  };
  const historyBefore = await history();
  const after = await call({
    operation: "edit_batch",
    expectedRevision: before.revision,
    expectedSlides: stable(before.slides),
    commands: [
      {
        op: "set_table_cell_format",
        elementId: target.elementId,
        row: targetRow,
        column: targetColumn,
        tableCellFormat: format,
      },
    ],
    dryRun: false,
    permission: { mode: "document", slideIndexes: [], elementIds: [] },
  });
  const afterTarget = after.slides
    .flatMap((slide) => slide.elements)
    .find((element) => element.stableId === target.stableId);
  const afterCell =
    afterTarget?.table?.cellDetails?.[targetRow]?.[targetColumn];
  const expectedCell = {
    ...beforeCell,
    fillColor: format.fillColor,
    fillOpacity: format.fillOpacity,
    color: format.fontColor,
    fontSize: format.fontSize,
    fontFamily: format.fontFamily,
    fontWeight: format.bold ? 150 : 100,
    underline: format.underline ? 1 : 0,
    strikethrough: format.strikethrough ? 1 : 0,
    textShadow: format.textShadow,
    // Impress stores character spacing in 1/100 mm and reports it in points.
    characterSpacing:
      Math.round(
        (Math.round((format.characterSpacing * 2540) / 72) * 7200) / 2540,
      ) / 100,
    paragraphAlignment: alignment === "center" ? 3 : 1,
    textMargins: {
      left: Math.round(format.marginLeft),
      right: Math.round(format.marginRight),
      top: Math.round(format.marginTop),
      bottom: Math.round(format.marginBottom),
    },
    borders: Object.fromEntries(
      [
        ["top", format.borderTop],
        ["right", format.borderRight],
        ["bottom", format.borderBottom],
        ["left", format.borderLeft],
      ].map(([edge, requested]) => [
        edge,
        {
          style: beforeCell.borders[edge].style,
          width: Math.round((requested.width * 2540) / 72),
          color: requested.color,
          innerWidth: 0,
          outerWidth: Math.round((requested.width * 2540) / 72),
          distance: 0,
        },
      ]),
    ),
  };
  const historyAfter = await history();
  if (
    after.revision === before.revision ||
    after.transaction?.status !== "applied" ||
    after.transaction?.commandCount !== 1 ||
    after.transaction?.undoActionsAdded !== 1 ||
    historyAfter.undo.length !== historyBefore.undo.length + 1 ||
    stable(cellComparable(afterCell)) !== stable(cellComparable(expectedCell))
  )
    throw new Error(
      "Table cell formatting did not apply exactly and atomically.",
    );

  await history("undo");
  await waitForState(before, "Table cell format Undo");
  await history("redo");
  const singleRedone = await waitForState(after, "Table cell format Redo");

  const emptyFormat = {
    fillColor: null,
    fillOpacity: null,
    fontColor: null,
    fontSize: null,
    fontFamily: null,
    bold: null,
    underline: null,
    strikethrough: null,
    textShadow: null,
    characterSpacing: null,
    paragraphAlignment: null,
    marginLeft: null,
    marginRight: null,
    marginTop: null,
    marginBottom: null,
    borderTop: null,
    borderRight: null,
    borderBottom: null,
    borderLeft: null,
  };
  const secondBefore =
    afterTarget.table.cellDetails[targetRow][targetColumn + 1];
  const firstBatchFormat = {
    ...emptyFormat,
    fontColor: expectedCell.color === 65535 ? 16711935 : 65535,
  };
  const secondBatchFormat = {
    ...emptyFormat,
    fillColor: secondBefore.fillColor === 16776960 ? 16711935 : 16776960,
  };
  const batchHistoryBefore = await history();
  const batchAfter = await call({
    operation: "edit_batch",
    expectedRevision: singleRedone.revision,
    expectedSlides: stable(singleRedone.slides),
    commands: [
      {
        op: "set_table_cell_format",
        elementId: target.elementId,
        row: targetRow,
        column: targetColumn,
        tableCellFormat: firstBatchFormat,
      },
      {
        op: "set_table_cell_format",
        elementId: target.elementId,
        row: targetRow,
        column: targetColumn + 1,
        tableCellFormat: secondBatchFormat,
      },
    ],
    dryRun: false,
    permission: { mode: "document", slideIndexes: [], elementIds: [] },
  });
  const batchTarget = batchAfter.slides
    .flatMap((slide) => slide.elements)
    .find((element) => element.stableId === target.stableId);
  const expectedBatchCells = [
    {
      row: targetRow,
      column: targetColumn,
      cell: { ...expectedCell, color: firstBatchFormat.fontColor },
    },
    {
      row: targetRow,
      column: targetColumn + 1,
      cell: { ...secondBefore, fillColor: secondBatchFormat.fillColor },
    },
  ];
  const batchHistoryAfter = await history();
  if (
    batchAfter.transaction?.status !== "applied" ||
    batchAfter.transaction?.commandCount !== 2 ||
    batchAfter.transaction?.undoActionsAdded !== 1 ||
    batchHistoryAfter.undo.length !== batchHistoryBefore.undo.length + 1 ||
    expectedBatchCells.some(
      ({ row, column, cell }) =>
        stable(
          cellComparable(batchTarget?.table?.cellDetails?.[row]?.[column]),
        ) !== stable(cellComparable(cell)),
    )
  )
    throw new Error(
      "Multi-cell table formatting did not apply as one exact transaction.",
    );
  await history("undo");
  await waitForState(singleRedone, "Multi-cell table format Undo");
  await history("redo");
  const redone = await waitForState(batchAfter, "Multi-cell table format Redo");

  if (process.env.SPELLBOOK_PROBE_SCREENSHOT) {
    const image = redone.images?.[0];
    if (!image?.pngBytes?.length)
      throw new Error("Table cell format returned no verification image.");
    await writeFile(
      path.resolve(process.env.SPELLBOOK_PROBE_SCREENSHOT),
      Buffer.from(image.pngBytes),
    );
  }
  await requestNativeProbeSave(page);

  const report = {
    enginePatchLevel: redone.engine.patchLevel,
    operation: "set_table_cell_format",
    atomic: true,
    multiCellBatchAtomic: true,
    undoExact: true,
    redoExact: true,
    persistenceExpected: {
      objectName: batchTarget.objectName,
      cells: expectedBatchCells,
    },
  };
  if (reportPath)
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx",
    });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await captureNativeSnapshots(page, "table-style");
  await browser.close();
}
