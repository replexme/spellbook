import { createRequire } from "node:module";
import { requestNativeProbeSave } from "./probe-save.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { documentStatesEquivalent } from "./document-state-evidence.mjs";
import {
  installNativeBridgeTrace,
  nativeBridgeDiagnostics,
  waitForNativeBridge,
} from "./native-bridge-probe.mjs";

const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");
const url = process.argv[2] ?? "http://localhost:3190";
const reportPath = process.argv[3] ? path.resolve(process.argv[3]) : null;
const screenshotDirectory = process.env.SPELLBOOK_PROBE_SCREENSHOT_DIR;
if (screenshotDirectory)
  mkdirSync(path.resolve(screenshotDirectory), { recursive: true });
const browser = await chromium.launch({ headless: true });
const continueOnHistoryDrift =
  process.env.SPELLBOOK_PROBE_CONTINUE_ON_HISTORY_DRIFT === "1";
const exerciseExplicitTableGeometry =
  process.env.SPELLBOOK_PROBE_EXPLICIT_TABLE_GEOMETRY === "1";

const reorderObjectKeys = (value) => {
  if (Array.isArray(value)) return value.map(reorderObjectKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .reverse()
        .map((key) => [key, reorderObjectKeys(value[key])]),
    );
  return value;
};

const firstDifference = (left, right, location = "document") => {
  if (Object.is(left, right)) return null;
  if (!left || !right || typeof left !== "object" || typeof right !== "object")
    return { location, expected: left, actual: right };
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const difference = firstDifference(
      left[key],
      right[key],
      `${location}.${key}`,
    );
    if (difference) return difference;
  }
  return null;
};

try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await installNativeBridgeTrace(page);
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
  await waitForNativeBridge(page);

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
  const remoteHistory = async (direction = null) => {
    const extensionFrame = page
      .frames()
      .find((frame) =>
        frame.url().includes("/extensions/org.spellbook.editor/"),
      );
    if (!extensionFrame) throw new Error("Native extension frame was lost.");
    return extensionFrame.evaluate(
      async (requestedDirection) =>
        cool.callRemote(function spellbookTableProbeHistory(remoteDirection) {
          const desktop = uno.idl.com.sun.star.frame.Desktop.create(
            uno.componentContext,
          );
          const undo = desktop
            .getCurrentFrame()
            .getController()
            .getModel()
            .getUndoManager();
          if (remoteDirection === "undo") undo.undo();
          else if (remoteDirection === "redo") undo.redo();
          else if (remoteDirection !== null)
            throw new Error("invalid_history_direction");
          return {
            undo: undo.getAllUndoActionTitles(),
            redo: undo.getAllRedoActionTitles(),
          };
        }, requestedDirection),
      direction,
    );
  };
  const waitForState = async (expected, label) => {
    const deadline = Date.now() + (continueOnHistoryDrift ? 2_000 : 10_000);
    let candidate;
    do {
      candidate = await call({ operation: "observe" });
      if (
        candidate.revision === expected.revision &&
        documentStatesEquivalent(expected.slides, candidate.slides) &&
        documentStatesEquivalent(expected.masters, candidate.masters)
      )
        return candidate;
      await page.waitForTimeout(100);
    } while (Date.now() < deadline);
    throw new Error(
      `${label} did not restore the exact document: ${JSON.stringify(
        firstDifference(
          { slides: expected.slides, masters: expected.masters },
          { slides: candidate?.slides, masters: candidate?.masters },
        ),
      )}`,
    );
  };
  const settleObservation = async () => {
    const deadline = Date.now() + 10_000;
    let candidate;
    let previous = null;
    let stableSince = 0;
    do {
      candidate = await call({ operation: "observe" });
      const key = JSON.stringify({
        slides: candidate.slides,
        masters: candidate.masters,
      });
      if (key !== previous) {
        previous = key;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 1_500) return candidate;
      await page.waitForTimeout(150);
    } while (Date.now() < deadline);
    throw new Error("Table document did not reach a stable observed state.");
  };

  let observed;
  try {
    observed = await settleObservation();
  } catch (error) {
    throw new Error(
      `${error.message} Bridge trace: ${JSON.stringify(
        await nativeBridgeDiagnostics(page),
      )}`,
      { cause: error },
    );
  }
  const persistenceBefore = {
    slides: structuredClone(observed.slides),
    masters: structuredClone(observed.masters),
  };
  const patchLevelMatch = /^undo-v([1-9][0-9]*)$/.exec(
    observed.engine?.patchLevel ?? "",
  );
  if (!patchLevelMatch || Number(patchLevelMatch[1]) < 5)
    throw new Error("The table-structure engine candidate is unavailable.");
  const initialTable = observed.slides
    .flatMap((slide) => slide.elements)
    .find(
      (element) =>
        element.parentElementId === null &&
        element.table?.rows >= 2 &&
        element.table?.columns >= 2,
    );
  if (!initialTable) throw new Error("No stable editable table was found.");
  const tableId = initialTable.elementId;
  const currentTable = () =>
    observed.slides
      .flatMap((slide) => slide.elements)
      .find((element) => element.elementId === tableId);
  const commands = [];
  const historyDrifts = [];
  const semanticDrifts = [];
  const tableGeometry = ({ x, y, width, height }) => ({
    x,
    y,
    width,
    height,
  });
  const tableGeometryEquivalent = (actual, expected) =>
    documentStatesEquivalent(
      [{ elements: [tableGeometry(expected)] }],
      [{ elements: [tableGeometry(actual)] }],
    );
  const assertTableGeometry = (operation, after, expected) => {
    const actual = tableGeometry(after);
    const mismatch = !tableGeometryEquivalent(actual, expected);
    if (!mismatch) return;
    const drift = { operation, expected, actual };
    if (!continueOnHistoryDrift)
      throw new Error(
        `${operation} did not preserve the exact table geometry: ${JSON.stringify(drift)}`,
      );
    semanticDrifts.push(drift);
  };
  const editWithUndoRoundTrip = async (command) => {
    const before = structuredClone(observed);
    const historyBefore = await remoteHistory();
    const beforeTable = before.slides
      .flatMap((slide) => slide.elements)
      .find((element) => element.elementId === command.elementId);
    const geometryCommands = [command];
    if (exerciseExplicitTableGeometry) {
      let width = beforeTable?.width;
      let height = beforeTable?.height;
      if (command.op === "insert_table_rows")
        height +=
          beforeTable.table.rowHeights[
            Math.min(command.index, beforeTable.table.rows - 1)
          ] * command.count;
      else if (command.op === "delete_table_rows")
        height -= beforeTable.table.rowHeights
          .slice(command.index, command.index + command.count)
          .reduce((sum, value) => sum + value, 0);
      else if (command.op === "insert_table_columns")
        width +=
          beforeTable.table.columnWidths[
            Math.min(command.index, beforeTable.table.columns - 1)
          ] * command.count;
      else if (command.op === "delete_table_columns")
        width -= beforeTable.table.columnWidths
          .slice(command.index, command.index + command.count)
          .reduce((sum, value) => sum + value, 0);
      else if (command.op === "set_table_row_height")
        height += command.height - beforeTable.table.rowHeights[command.index];
      else if (command.op === "set_table_column_width")
        width += command.width - beforeTable.table.columnWidths[command.index];
      if (width !== beforeTable?.width || height !== beforeTable?.height)
        geometryCommands.push({
          op: "resize",
          elementId: command.elementId,
          width,
          height,
        });
    }
    const request = {
      operation: geometryCommands.length === 1 ? "edit" : "edit_batch",
      expectedRevision: observed.revision,
      expectedSlides: JSON.stringify(reorderObjectKeys(observed.slides)),
      permission: { mode: "document", slideIndexes: [], elementIds: [] },
      ...(geometryCommands.length === 1
        ? { command }
        : { commands: geometryCommands }),
    };
    observed = await call(request);
    const after = structuredClone(observed);
    const historyAfter = await remoteHistory();
    if (before.revision === after.revision)
      throw new Error(`${command.op} did not change the revision.`);
    if (historyAfter.undo.length !== historyBefore.undo.length + 1)
      throw new Error(
        `${command.op} added ${historyAfter.undo.length - historyBefore.undo.length} Undo actions.`,
      );
    if (screenshotDirectory) {
      const image = after.images?.[0];
      if (!image?.pngBytes?.length)
        throw new Error(`${command.op} returned no verification image.`);
      writeFileSync(
        path.join(
          path.resolve(screenshotDirectory),
          `${String(commands.length + 1).padStart(2, "0")}-${command.op}.png`,
        ),
        Buffer.from(image.pngBytes),
      );
    }
    await remoteHistory("undo");
    try {
      observed = await waitForState(before, `${command.op} Undo`);
    } catch (error) {
      if (!continueOnHistoryDrift) throw error;
      observed = await settleObservation();
      historyDrifts.push({
        operation: command.op,
        direction: "undo",
        difference: firstDifference(
          { slides: before.slides, masters: before.masters },
          { slides: observed.slides, masters: observed.masters },
        ),
      });
    }
    await remoteHistory("redo");
    try {
      observed = await waitForState(after, `${command.op} Redo`);
    } catch (error) {
      if (!continueOnHistoryDrift) throw error;
      observed = await settleObservation();
      historyDrifts.push({
        operation: command.op,
        direction: "redo",
        difference: firstDifference(
          { slides: after.slides, masters: after.masters },
          { slides: observed.slides, masters: observed.masters },
        ),
      });
    }
    commands.push(command.op);
  };

  const beforeRowInsert = structuredClone(currentTable());
  const inheritedRowHeight = beforeRowInsert.table.rowHeights[1];
  await editWithUndoRoundTrip({
    op: "insert_table_rows",
    elementId: tableId,
    index: 1,
    count: 1,
  });
  const afterRowInsert = currentTable();
  const rowInsertGeometryMismatch =
    afterRowInsert.table.rowHeights[1] !== inheritedRowHeight ||
    inheritedRowHeight <= 0 ||
    !tableGeometryEquivalent(afterRowInsert, {
      x: beforeRowInsert.x,
      y: beforeRowInsert.y,
      width: beforeRowInsert.width,
      height: beforeRowInsert.height + inheritedRowHeight,
    });
  if (rowInsertGeometryMismatch && !continueOnHistoryDrift)
    throw new Error(
      `Inserted row did not inherit the live table geometry: ${JSON.stringify({
        before: {
          x: beforeRowInsert.x,
          y: beforeRowInsert.y,
          width: beforeRowInsert.width,
          height: beforeRowInsert.height,
          rowHeights: beforeRowInsert.table.rowHeights,
        },
        after: {
          x: afterRowInsert.x,
          y: afterRowInsert.y,
          width: afterRowInsert.width,
          height: afterRowInsert.height,
          rowHeights: afterRowInsert.table.rowHeights,
        },
        inheritedRowHeight,
      })}`,
    );
  if (rowInsertGeometryMismatch)
    semanticDrifts.push({
      operation: "insert_table_rows",
      expectedHeight: beforeRowInsert.height + inheritedRowHeight,
      actualHeight: afterRowInsert.height,
      rowHeights: afterRowInsert.table.rowHeights,
    });

  const beforeColumnInsert = structuredClone(currentTable());
  const inheritedColumnWidth = beforeColumnInsert.table.columnWidths[1];
  await editWithUndoRoundTrip({
    op: "insert_table_columns",
    elementId: tableId,
    index: 1,
    count: 1,
  });
  const afterColumnInsert = currentTable();
  const columnInsertGeometryMismatch =
    afterColumnInsert.table.columnWidths[1] !== inheritedColumnWidth ||
    inheritedColumnWidth <= 0 ||
    !tableGeometryEquivalent(afterColumnInsert, {
      x: beforeColumnInsert.x,
      y: beforeColumnInsert.y,
      width: beforeColumnInsert.width + inheritedColumnWidth,
      height: beforeColumnInsert.height,
    });
  if (columnInsertGeometryMismatch && !continueOnHistoryDrift)
    throw new Error(
      `Inserted column did not inherit the live table geometry: ${JSON.stringify(
        {
          before: {
            x: beforeColumnInsert.x,
            y: beforeColumnInsert.y,
            width: beforeColumnInsert.width,
            height: beforeColumnInsert.height,
            columnWidths: beforeColumnInsert.table.columnWidths,
          },
          after: {
            x: afterColumnInsert.x,
            y: afterColumnInsert.y,
            width: afterColumnInsert.width,
            height: afterColumnInsert.height,
            columnWidths: afterColumnInsert.table.columnWidths,
          },
          inheritedColumnWidth,
        },
      )}`,
    );
  if (columnInsertGeometryMismatch)
    semanticDrifts.push({
      operation: "insert_table_columns",
      expectedWidth: beforeColumnInsert.width + inheritedColumnWidth,
      actualWidth: afterColumnInsert.width,
      columnWidths: afterColumnInsert.table.columnWidths,
    });

  const beforeRowHeight = structuredClone(currentTable());
  const changedRowHeight = beforeRowHeight.table.rowHeights[1] + 100;
  await editWithUndoRoundTrip({
    op: "set_table_row_height",
    elementId: tableId,
    index: 1,
    height: changedRowHeight,
  });
  assertTableGeometry("set_table_row_height", currentTable(), {
    x: beforeRowHeight.x,
    y: beforeRowHeight.y,
    width: beforeRowHeight.width,
    height: beforeRowHeight.height + 100,
  });

  const beforeColumnWidth = structuredClone(currentTable());
  const changedColumnWidth = beforeColumnWidth.table.columnWidths[1] + 100;
  await editWithUndoRoundTrip({
    op: "set_table_column_width",
    elementId: tableId,
    index: 1,
    width: changedColumnWidth,
  });
  assertTableGeometry("set_table_column_width", currentTable(), {
    x: beforeColumnWidth.x,
    y: beforeColumnWidth.y,
    width: beforeColumnWidth.width + 100,
    height: beforeColumnWidth.height,
  });

  const beforeMerge = structuredClone(currentTable());
  await editWithUndoRoundTrip({
    op: "merge_table_cells",
    elementId: tableId,
    startRow: 0,
    startColumn: 0,
    endRow: 1,
    endColumn: 1,
  });
  if (
    !currentTable().table.mergedRanges.some(
      (range) =>
        range.startRow === 0 &&
        range.startColumn === 0 &&
        range.endRow === 1 &&
        range.endColumn === 1,
    )
  )
    throw new Error("Merged table range was not observed.");
  assertTableGeometry("merge_table_cells", currentTable(), {
    x: beforeMerge.x,
    y: beforeMerge.y,
    width: beforeMerge.width,
    height: beforeMerge.height,
  });

  const beforeSplit = structuredClone(currentTable());
  await editWithUndoRoundTrip({
    op: "split_table_cell",
    elementId: tableId,
    row: 0,
    column: 0,
    columns: 2,
    rows: 2,
  });
  if (
    currentTable().table.mergedRanges.some(
      (range) =>
        range.startRow <= 0 &&
        range.endRow >= 0 &&
        range.startColumn <= 0 &&
        range.endColumn >= 0,
    )
  )
    throw new Error("Split table cell left a merged range behind.");
  assertTableGeometry("split_table_cell", currentTable(), {
    x: beforeSplit.x,
    y: beforeSplit.y,
    width: beforeSplit.width,
    height: beforeSplit.height,
  });

  const beforeRowDelete = structuredClone(currentTable());
  const rowDeleteIndex = beforeRowDelete.table.rows - 1;
  const deletedRowHeight = beforeRowDelete.table.rowHeights[rowDeleteIndex];
  await editWithUndoRoundTrip({
    op: "delete_table_rows",
    elementId: tableId,
    index: rowDeleteIndex,
    count: 1,
  });
  assertTableGeometry("delete_table_rows", currentTable(), {
    x: beforeRowDelete.x,
    y: beforeRowDelete.y,
    width: beforeRowDelete.width,
    height: beforeRowDelete.height - deletedRowHeight,
  });

  const beforeColumnDelete = structuredClone(currentTable());
  const columnDeleteIndex = beforeColumnDelete.table.columns - 1;
  const deletedColumnWidth =
    beforeColumnDelete.table.columnWidths[columnDeleteIndex];
  await editWithUndoRoundTrip({
    op: "delete_table_columns",
    elementId: tableId,
    index: columnDeleteIndex,
    count: 1,
  });
  assertTableGeometry("delete_table_columns", currentTable(), {
    x: beforeColumnDelete.x,
    y: beforeColumnDelete.y,
    width: beforeColumnDelete.width - deletedColumnWidth,
    height: beforeColumnDelete.height,
  });

  await requestNativeProbeSave(page);
  const report = {
    engine: observed.engine,
    tableId,
    commands,
    uniqueCommandCount: new Set(commands).size,
    historyDrifts,
    semanticDrifts,
    finalTable: currentTable().table,
    persistenceBefore,
    persistenceExpected: {
      objectName: currentTable().objectName,
      slides: observed.slides,
      masters: observed.masters,
    },
    save: { acknowledged: true },
  };
  if (reportPath)
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx",
    });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await browser.close();
}
