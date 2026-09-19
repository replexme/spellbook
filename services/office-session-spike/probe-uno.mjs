import { createRequire } from "node:module";
import { probeEnginePatchVersion } from "./probe-engine-patch.mjs";
import { requestNativeProbeSave } from "./probe-save.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  firstDocumentStateDifference,
  quantizedGeometryEquivalent,
  undoDocumentStateEquivalent,
} from "./document-state-evidence.mjs";
import { persistenceStateFromObservation } from "./persistence-evidence.mjs";
import { activeTextFontEvidence } from "./text-format-evidence.mjs";
import { captureNativeSnapshots } from "./probe-raw-snapshots.mjs";

const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");
const nativeEditContract = require("../../contracts/native-edit-capabilities.json");
const nativeConformanceContract = require("../../contracts/native-mutation-conformance.json");
const url = process.argv[2] ?? "http://localhost:3190";
const reportPath = process.argv[3] ? path.resolve(process.argv[3]) : null;
const probePatchedEngine = process.env.SPELLBOOK_PROBE_PATCHED_ENGINE === "1";
const probeTableStructureRequested =
  process.env.SPELLBOOK_PROBE_TABLE_STRUCTURE === "1";
const screenshotDirectory = process.env.SPELLBOOK_PROBE_SCREENSHOT_DIR;
const expectedOperations = process.env.SPELLBOOK_PROBE_EXPECTED_OPERATIONS
  ? JSON.parse(process.env.SPELLBOOK_PROBE_EXPECTED_OPERATIONS)
  : null;
if (
  expectedOperations !== null &&
  (!Array.isArray(expectedOperations) ||
    expectedOperations.some((operation) => typeof operation !== "string"))
)
  throw new Error(
    "SPELLBOOK_PROBE_EXPECTED_OPERATIONS must be a JSON string array.",
  );
if (screenshotDirectory)
  mkdirSync(path.resolve(screenshotDirectory), { recursive: true });
const visualEvidenceOperations = new Set(
  Object.entries(nativeEditContract.mutationModel.operations)
    .filter(([, operation]) =>
      nativeEditContract.mutationModel.families[
        operation.family
      ].verification.includes("visual"),
    )
    .map(([operation]) => operation),
);
const browser = await chromium.launch({ headless: true });
let page;

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

try {
  page = await browser.newPage({
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

  let observed = await call({ operation: "observe" });
  const persistenceBefore = persistenceStateFromObservation(observed);
  const enginePatchVersion = probeEnginePatchVersion(
    observed.engine?.patchLevel,
  );
  const engineOperationAvailable = (operation) => {
    const contract = nativeEditContract.mutationModel.operations[operation];
    return (
      contract &&
      contract.availability !== "format_excluded" &&
      contract.minEnginePatch <= enginePatchVersion
    );
  };
  const probeTextRangeEngine = enginePatchVersion >= 4;
  const tableStructureEngineAvailable = enginePatchVersion >= 5;
  if (probeTableStructureRequested && !tableStructureEngineAvailable)
    throw new Error("The requested table-structure engine is unavailable.");
  const probeTableStructureEngine =
    probeTableStructureRequested && tableStructureEngineAvailable;
  const target = observed.slides
    .flatMap((slide) => slide.elements)
    .find((element) => element.text && element.parentElementId === null);
  if (!target) throw new Error("No editable text object in probe deck.");
  const geometry =
    observed.slides
      .flatMap((slide) => slide.elements)
      .find(
        (element) =>
          !element.text &&
          element.parentElementId === null &&
          element.rotation === 0 &&
          !element.moveProtected &&
          !element.sizeProtected,
      ) ??
    observed.slides
      .flatMap((slide) => slide.elements)
      .find((element) => !element.text && element.parentElementId === null) ??
    target;
  const results = [];
  let textRangePersistence = null;
  const edit = async (command) => {
    try {
      observed = await call({
        operation: "edit",
        // Production observations cross PostgreSQL JSONB, which does not
        // preserve JavaScript object key order. Exercise the same semantic
        // document with deliberately reordered keys on every edit.
        expectedSlides: JSON.stringify(reorderObjectKeys(observed.slides)),
        expectedRevision: observed.revision,
        command,
        permission: { mode: "document", slideIndexes: [], elementIds: [] },
      });
    } catch (error) {
      throw new Error(`${JSON.stringify(command)}: ${error.message}`);
    }
    results.push(command.op);
    if (screenshotDirectory && visualEvidenceOperations.has(command.op)) {
      const image = observed.images?.[0];
      if (!image?.pngBytes?.length)
        throw new Error(`${command.op} did not return a verification image.`);
      writeFileSync(
        path.join(
          path.resolve(screenshotDirectory),
          `${String(results.length).padStart(2, "0")}-${command.op}.png`,
        ),
        Buffer.from(image.pngBytes),
      );
    }
  };
  const summarizeSlides = (slides) =>
    slides.map((slide) => ({
      slideIndex: slide.slideIndex,
      name: slide.name,
      layout: slide.layout,
      elements: slide.elements
        .filter((element) => element.parentElementId === null)
        .map((element) => ({
          name: element.name,
          text: element.text,
          x: element.x,
          y: element.y,
          width: element.width,
          height: element.height,
        })),
    }));
  const waitForDocumentState = async (revision, expected, label) => {
    const deadline = Date.now() + 10_000;
    let candidate;
    do {
      candidate = await call({ operation: "observe" });
      // The same Undo rule as every other probe: the exact revision, which
      // covers authored masters but not their diagnostic shape counts, and
      // exact slide state.
      if (
        undoDocumentStateEquivalent(
          { revision, slides: expected.slides },
          candidate,
        )
      )
        return candidate;
      await page.waitForTimeout(100);
    } while (Date.now() < deadline);
    throw new Error(
      `Native ${label} did not restore the product-equivalent document state: ${JSON.stringify({ expectedRevision: revision, actualRevision: candidate?.revision, difference: firstDocumentStateDifference({ slides: expected.slides, masters: expected.masters }, { slides: candidate?.slides, masters: candidate?.masters }), expected: summarizeSlides(expected.slides), actual: summarizeSlides(candidate?.slides ?? []) })}`,
    );
  };
  const settleObservation = async (label) => {
    const deadline = Date.now() + 10_000;
    let candidate;
    let previousKey = null;
    let stableSince = 0;
    do {
      candidate = await call({ operation: "observe" });
      const key = JSON.stringify({
        slides: candidate.slides,
        masters: candidate.masters,
      });
      if (key !== previousKey) {
        previousKey = key;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 1_500) {
        return candidate;
      }
      await page.waitForTimeout(150);
    } while (Date.now() < deadline);
    throw new Error(`Native ${label} did not reach a stable observed state.`);
  };
  const dispatchHistory = async (command) => {
    const extensionFrame = page
      .frames()
      .find((frame) =>
        frame.url().includes("/extensions/org.spellbook.editor/"),
      );
    if (!extensionFrame) throw new Error("Native extension frame was lost.");
    return extensionFrame.evaluate(
      async (direction) =>
        cool.callRemote(function spellbookProbeHistory(remoteDirection) {
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
          else throw new Error("invalid_history_direction");
          return {
            undo: undo.getAllUndoActionTitles(),
            redo: undo.getAllRedoActionTitles(),
          };
        }, direction),
      command,
    );
  };
  const editWithUndoRoundTrip = async (command) => {
    const beforeState = structuredClone({
      slides: observed.slides,
      masters: observed.masters,
    });
    const beforeRevision = observed.revision;
    await edit(command);
    const afterState = structuredClone({
      slides: observed.slides,
      masters: observed.masters,
    });
    const afterRevision = observed.revision;
    if (beforeRevision === afterRevision)
      throw new Error(`${command.op} did not change the document revision.`);
    const undoHistory = await dispatchHistory("undo");
    try {
      observed = await waitForDocumentState(
        beforeRevision,
        beforeState,
        `${command.op} undo`,
      );
    } catch (error) {
      throw new Error(
        `${error.message} history=${JSON.stringify(undoHistory)}`,
      );
    }
    await dispatchHistory("redo");
    observed = await waitForDocumentState(
      afterRevision,
      afterState,
      `${command.op} redo`,
    );
  };
  await edit({
    op: "replace_text",
    elementId: target.elementId,
    text: `${target.text} · 검증`,
  });
  let current = observed.slides[geometry.elementId.split("/")[0]].elements.find(
    (element) => element.elementId === geometry.elementId,
  );
  await edit({
    op: "move",
    elementId: geometry.elementId,
    x: current.x + 100,
    y: current.y + 100,
  });
  current = observed.slides[0].elements.find(
    (element) => element.elementId === geometry.elementId,
  );
  await edit({
    op: "resize",
    elementId: geometry.elementId,
    width: current.width + 100,
    height: current.height + 100,
  });
  await edit({ op: "font_size", elementId: target.elementId, size: 19 });
  await edit({ op: "bold", elementId: target.elementId, bold: true });
  await edit({ op: "italic", elementId: target.elementId, italic: true });
  await edit({ op: "underline", elementId: target.elementId, underline: true });
  await editWithUndoRoundTrip({
    op: "strikethrough",
    elementId: target.elementId,
    strikethrough: true,
  });
  if (probePatchedEngine && engineOperationAvailable("text_shadow"))
    await editWithUndoRoundTrip({
      op: "text_shadow",
      elementId: target.elementId,
      shadow: true,
    });
  const initialAutofit =
    target.textFitToSize !== null &&
    !String(target.textFitToSize).toUpperCase().includes("NONE");
  await editWithUndoRoundTrip({
    op: "text_autofit",
    elementId: target.elementId,
    autofit: !initialAutofit,
  });
  await edit({
    op: "font_family",
    elementId: target.elementId,
    family: "Liberation Sans",
  });
  await edit({
    op: "font_color",
    elementId: target.elementId,
    color: 16711680,
  });
  await edit({
    op: "fill_color",
    elementId: target.elementId,
    color: 16776960,
  });
  const currentText = () =>
    observed.slides
      .flatMap((slide) => slide.elements)
      .find((element) => element.text && element.parentElementId === null);
  const currentGraphic = () =>
    observed.slides
      .flatMap((slide) => slide.elements)
      .find(
        (element) =>
          !element.text &&
          element.parentElementId === null &&
          !element.childElementIds.length,
      );
  await edit({
    op: "line_color",
    elementId: currentGraphic().elementId,
    color: 65280,
  });
  await edit({
    op: "line_width",
    elementId: currentGraphic().elementId,
    size: 2,
  });
  await editWithUndoRoundTrip({
    op: "fill_opacity",
    elementId: currentGraphic().elementId,
    opacity: 63,
  });
  await editWithUndoRoundTrip({
    op: "line_opacity",
    elementId: currentGraphic().elementId,
    opacity: 57,
  });
  if (engineOperationAvailable("set_shape_fill"))
    await editWithUndoRoundTrip({
      op: "set_shape_fill",
      elementId: currentGraphic().elementId,
      shapeFill: {
        type: "solid",
        color: 0x4f46e5,
        opacity: 82,
        catalogName: null,
      },
    });
  if (engineOperationAvailable("set_shape_effects"))
    await editWithUndoRoundTrip({
      op: "set_shape_effects",
      elementId: currentGraphic().elementId,
      shapeEffects: {
        glowRadius: 120,
        glowColor: 0x6366f1,
        glowOpacity: 74,
        softEdgeRadius: 60,
      },
    });
  await edit({
    op: "paragraph_alignment",
    elementId: currentText().elementId,
    alignment: "center",
  });
  await edit({
    op: "duplicate_element",
    elementId: currentGraphic().elementId,
  });
  await edit({
    op: "duplicate_element",
    elementId: currentGraphic().elementId,
  });
  let graphics = observed.slides[0].elements.filter(
    (element) =>
      !element.text &&
      element.parentElementId === null &&
      !element.childElementIds.length,
  );
  for (let index = 0; index < graphics.length; index++) {
    const item = graphics[index];
    await edit({
      op: "move",
      elementId: item.elementId,
      x: item.x + (index + 1) * 500,
      y: item.y + (index + 1) * 300,
    });
    graphics = observed.slides[0].elements.filter(
      (element) =>
        !element.text &&
        element.parentElementId === null &&
        !element.childElementIds.length,
    );
  }
  await edit({
    op: "align",
    elementIds: graphics.slice(0, 2).map((element) => element.elementId),
    alignment: "top",
  });
  graphics = observed.slides[0].elements.filter(
    (element) =>
      !element.text &&
      element.parentElementId === null &&
      !element.childElementIds.length,
  );
  await edit({
    op: "distribute",
    elementIds: graphics.slice(0, 3).map((element) => element.elementId),
    axis: "horizontal",
  });
  graphics = observed.slides[0].elements.filter(
    (element) =>
      !element.text &&
      element.parentElementId === null &&
      !element.childElementIds.length,
  );
  await edit({
    op: "group",
    elementIds: graphics.slice(0, 2).map((element) => element.elementId),
  });
  const group = observed.slides[0].elements.find(
    (element) =>
      element.parentElementId === null && element.childElementIds.length,
  );
  if (!group) throw new Error("Native group was not identified.");
  await edit({ op: "ungroup", elementId: group.elementId });
  await edit({
    op: "rotate",
    elementId: currentGraphic().elementId,
    degrees: 15,
  });
  await edit({
    op: "flip",
    elementId: currentGraphic().elementId,
    axis: "horizontal",
  });
  const frontTarget = observed.slides[0].elements.find(
    (element) => element.parentElementId === null && element.zIndex === 0,
  );
  await edit({
    op: "z_order",
    elementId: frontTarget.elementId,
    position: "front",
  });
  const beforeIds = new Set(
    observed.slides[0].elements.map((element) => element.elementId),
  );
  await edit({
    op: "duplicate_element",
    elementId: currentText().elementId,
  });
  const duplicate = observed.slides[0].elements.find(
    (element) =>
      element.parentElementId === null && !beforeIds.has(element.elementId),
  );
  if (!duplicate) throw new Error("Duplicate object was not identified.");
  await edit({ op: "delete_element", elementId: duplicate.elementId });
  await edit({
    op: "add_text_box",
    slideIndex: 0,
    x: 9000,
    y: 1200,
    width: 6000,
    height: 1800,
    text: "새 텍스트 상자",
  });
  const advancedObjectIds = new Set(
    observed.slides[0].elements.map((element) => element.stableId),
  );
  await edit({
    op: "add_shape",
    slideIndex: 0,
    x: 9000,
    y: 4000,
    width: 2500,
    height: 1800,
    geometry: "rectangle",
    color: 16753920,
  });
  await edit({
    op: "add_shape",
    slideIndex: 0,
    x: 12000,
    y: 4000,
    width: 2500,
    height: 1800,
    geometry: "ellipse",
    color: 255,
  });
  await edit({
    op: "add_shape",
    slideIndex: 0,
    x: 9000,
    y: 6500,
    width: 5500,
    height: 100,
    geometry: "line",
    color: 16711680,
  });
  if (engineOperationAvailable("add_connector")) {
    await editWithUndoRoundTrip({
      op: "add_connector",
      slideIndex: 0,
      x: 9000,
      y: 7600,
      width: 5500,
      height: 1200,
      connectorKind: "standard",
    });
    const connector = observed.slides[0].elements.find(
      (element) =>
        !advancedObjectIds.has(element.stableId) && element.connector,
    );
    if (!connector) throw new Error("Native connector was not identified.");
    if (engineOperationAvailable("set_connector"))
      await editWithUndoRoundTrip({
        op: "set_connector",
        elementId: connector.elementId,
        connector: {
          kind: "curve",
          start: {
            x: Number(connector.connector.start?.x ?? connector.x) + 50,
            y: Number(connector.connector.start?.y ?? connector.y) + 50,
          },
          end: {
            x:
              Number(
                connector.connector.end?.x ?? connector.x + connector.width,
              ) + 100,
            y:
              Number(
                connector.connector.end?.y ?? connector.y + connector.height,
              ) + 100,
          },
          startElementId: null,
          endElementId: null,
          startGluePoint: null,
          endGluePoint: null,
        },
      });
  }
  if (engineOperationAvailable("add_freeform"))
    await editWithUndoRoundTrip({
      op: "add_freeform",
      slideIndex: 0,
      x: 15000,
      y: 7200,
      width: 2600,
      height: 1800,
      points: [
        { x: 0, y: 1700 },
        { x: 1200, y: 0 },
        { x: 2500, y: 1700 },
      ],
      closed: true,
      color: 0x14b8a6,
    });
  if (engineOperationAvailable("set_reading_order")) {
    const readingOrder = observed.slides[0].elements
      .filter((element) => element.parentElementId === null)
      .sort((left, right) => left.readingOrder - right.readingOrder)
      .map((element) => element.elementId)
      .reverse();
    if (readingOrder.length < 2)
      throw new Error("Not enough objects for reading-order verification.");
    await editWithUndoRoundTrip({
      op: "set_reading_order",
      elementIds: readingOrder,
    });
  }
  await editWithUndoRoundTrip({
    op: "add_table",
    slideIndex: 0,
    x: 15500,
    y: 1200,
    width: 9000,
    height: 4500,
    cells: [
      ["항목", "값"],
      ["속도", "빠름"],
    ],
  });
  // Impress finishes table layout after the remote operation returns. Use the
  // settled, canonical geometry as the baseline for subsequent exact Undo
  // checks instead of comparing against a transient XShape size.
  observed = await settleObservation("add_table layout");
  const table = observed.slides[0].elements.find((element) => element.table);
  if (!table) throw new Error("Native table was not identified.");
  if (table.table.cells[1][1] !== "빠름")
    throw new Error("Native table content was not preserved.");
  const currentTable = () =>
    observed.slides
      .flatMap((slide) => slide.elements)
      .find((element) => element.elementId === table.elementId);
  const assertTableGeometry = (operation, actual, expected) => {
    const geometry = {
      x: actual.x,
      y: actual.y,
      width: actual.width,
      height: actual.height,
    };
    if (
      Object.keys(expected).some(
        (key) => !quantizedGeometryEquivalent(expected[key], geometry[key]),
      )
    )
      throw new Error(
        `${operation} changed table geometry incorrectly: ${JSON.stringify({ expected, actual: geometry })}`,
      );
  };
  if (
    table.table.rowHeights?.length !== table.table.rows ||
    table.table.columnWidths?.length !== table.table.columns ||
    !Array.isArray(table.table.mergedRanges) ||
    table.table.cellDetails?.length !== table.table.rows ||
    table.table.cellDetails?.some(
      (row) =>
        row.length !== table.table.columns ||
        row.some(
          (cell) =>
            !cell.borders ||
            !Object.hasOwn(cell.borders, "top") ||
            !Object.hasOwn(cell, "fillOpacity") ||
            !Object.hasOwn(cell, "textMargins"),
        ),
    )
  )
    throw new Error(
      "Native table structure and style were not fully observed.",
    );
  if (probeTableStructureEngine) {
    const beforeRowInsert = structuredClone(currentTable());
    const inheritedRowHeight = beforeRowInsert.table.rowHeights[1];
    await editWithUndoRoundTrip({
      op: "insert_table_rows",
      elementId: table.elementId,
      index: 1,
      count: 1,
    });
    const afterRowInsert = currentTable();
    if (
      afterRowInsert.table.rowHeights[1] !== inheritedRowHeight ||
      inheritedRowHeight <= 0 ||
      !quantizedGeometryEquivalent(
        beforeRowInsert.height + inheritedRowHeight,
        afterRowInsert.height,
      ) ||
      !quantizedGeometryEquivalent(beforeRowInsert.x, afterRowInsert.x) ||
      !quantizedGeometryEquivalent(beforeRowInsert.y, afterRowInsert.y) ||
      !quantizedGeometryEquivalent(beforeRowInsert.width, afterRowInsert.width)
    )
      throw new Error(
        "Inserted table row did not inherit exact live geometry.",
      );
    const beforeColumnInsert = structuredClone(currentTable());
    const inheritedColumnWidth = beforeColumnInsert.table.columnWidths[1];
    await editWithUndoRoundTrip({
      op: "insert_table_columns",
      elementId: table.elementId,
      index: 1,
      count: 1,
    });
    const afterColumnInsert = currentTable();
    if (
      afterColumnInsert.table.columnWidths[1] !== inheritedColumnWidth ||
      inheritedColumnWidth <= 0 ||
      !quantizedGeometryEquivalent(
        beforeColumnInsert.width + inheritedColumnWidth,
        afterColumnInsert.width,
      ) ||
      !quantizedGeometryEquivalent(beforeColumnInsert.x, afterColumnInsert.x) ||
      !quantizedGeometryEquivalent(beforeColumnInsert.y, afterColumnInsert.y) ||
      !quantizedGeometryEquivalent(
        beforeColumnInsert.height,
        afterColumnInsert.height,
      )
    )
      throw new Error(
        "Inserted table column did not inherit exact live geometry.",
      );
    const beforeRowHeight = structuredClone(currentTable());
    await editWithUndoRoundTrip({
      op: "set_table_row_height",
      elementId: table.elementId,
      index: 1,
      height: beforeRowHeight.table.rowHeights[1] + 100,
    });
    assertTableGeometry("set_table_row_height", currentTable(), {
      x: beforeRowHeight.x,
      y: beforeRowHeight.y,
      width: beforeRowHeight.width,
      height: beforeRowHeight.height + 100,
    });

    const beforeColumnWidth = structuredClone(currentTable());
    await editWithUndoRoundTrip({
      op: "set_table_column_width",
      elementId: table.elementId,
      index: 1,
      width: beforeColumnWidth.table.columnWidths[1] + 100,
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
      elementId: table.elementId,
      startRow: 0,
      startColumn: 0,
      endRow: 1,
      endColumn: 1,
    });
    assertTableGeometry("merge_table_cells", currentTable(), {
      x: beforeMerge.x,
      y: beforeMerge.y,
      width: beforeMerge.width,
      height: beforeMerge.height,
    });

    const beforeSplit = structuredClone(currentTable());
    await editWithUndoRoundTrip({
      op: "split_table_cell",
      elementId: table.elementId,
      row: 0,
      column: 0,
      columns: 2,
      rows: 2,
    });
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
      elementId: table.elementId,
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
      elementId: table.elementId,
      index: columnDeleteIndex,
      count: 1,
    });
    assertTableGeometry("delete_table_columns", currentTable(), {
      x: beforeColumnDelete.x,
      y: beforeColumnDelete.y,
      width: beforeColumnDelete.width - deletedColumnWidth,
      height: beforeColumnDelete.height,
    });
  }
  if (probePatchedEngine) {
    await editWithUndoRoundTrip({
      op: "set_table_cell",
      elementId: table.elementId,
      row: 1,
      column: 1,
      text: "정확한 Undo",
    });
    const nextBackground =
      observed.slides[0].backgroundColor === 15790320 ? 15132390 : 15790320;
    await editWithUndoRoundTrip({
      op: "set_background",
      slideIndex: 0,
      color: nextBackground,
    });
  }
  const reusableMastersBeforeStructureEdits = structuredClone(observed.masters);
  const assertReusableMastersUnchanged = (operation) => {
    if (
      JSON.stringify(observed.masters) !==
      JSON.stringify(reusableMastersBeforeStructureEdits)
    )
      throw new Error(
        `${operation} changed reusable masters: ${JSON.stringify({ before: reusableMastersBeforeStructureEdits.map(({ masterIndex, name, shapeCount }) => ({ masterIndex, name, shapeCount })), after: observed.masters.map(({ masterIndex, name, shapeCount }) => ({ masterIndex, name, shapeCount })) })}`,
      );
  };
  await editWithUndoRoundTrip({
    op: "set_speaker_notes",
    slideIndex: 0,
    text: "AI와 사용자가 함께 확인하는 발표자 노트",
  });
  assertReusableMastersUnchanged("set_speaker_notes");
  if (engineOperationAvailable("add_comment")) {
    await editWithUndoRoundTrip({
      op: "add_comment",
      slideIndex: 0,
      text: "Spellbook comment",
      author: "Spellbook AI",
      initials: "AI",
      x: 800,
      y: 800,
    });
    let comment = observed.slides[0].comments.at(-1);
    if (!comment) throw new Error("Native comment was not identified.");
    await editWithUndoRoundTrip({
      op: "edit_comment",
      slideIndex: 0,
      commentIndex: comment.commentIndex,
      expectedText: comment.text,
      text: "Spellbook reviewed comment",
      author: "Spellbook AI",
      initials: "AI",
    });
    comment = observed.slides[0].comments.find(
      (candidate) => candidate.commentIndex === comment.commentIndex,
    );
    if (!comment) throw new Error("Edited native comment was not identified.");
    await editWithUndoRoundTrip({
      op: "delete_comment",
      slideIndex: 0,
      commentIndex: comment.commentIndex,
      expectedText: comment.text,
    });
  }
  await edit({ op: "insert_slide", slideIndex: 0 });
  assertReusableMastersUnchanged("insert_slide");
  await edit({ op: "duplicate_slide", slideIndex: 0 });
  assertReusableMastersUnchanged("duplicate_slide");
  let slideTarget = observed.slides.length - 1;
  const layoutMaster = observed.masters.find(
    (candidate) =>
      candidate.masterIndex !== observed.slides[slideTarget].masterIndex,
  );
  if (probePatchedEngine && engineOperationAvailable("set_slide_layout")) {
    const mastersBeforeLayout = structuredClone(observed.masters);
    await editWithUndoRoundTrip({
      op: "set_slide_layout",
      slideIndex: slideTarget,
      masterIndex: layoutMaster.masterIndex,
      layout: layoutMaster.layout,
    });
    if (
      JSON.stringify(observed.masters) !== JSON.stringify(mastersBeforeLayout)
    )
      throw new Error(
        `Slide-local layout selection changed reusable masters: ${JSON.stringify({ before: mastersBeforeLayout.map(({ masterIndex, name, shapeCount }) => ({ masterIndex, name, shapeCount })), after: observed.masters.map(({ masterIndex, name, shapeCount }) => ({ masterIndex, name, shapeCount })) })}`,
      );
  }
  const targetSlideIndex = slideTarget === 1 ? 2 : 1;
  await editWithUndoRoundTrip({
    op: "move_slide",
    slideIndex: slideTarget,
    targetSlideIndex,
  });
  if (probePatchedEngine) {
    const patchSlideIndex = observed.slides.length - 1;
    await editWithUndoRoundTrip({
      op: "rename_slide",
      slideIndex: patchSlideIndex,
      name: "AI 검증 슬라이드",
    });
    await editWithUndoRoundTrip({
      op: "set_slide_hidden",
      slideIndex: patchSlideIndex,
      hidden: !observed.slides[patchSlideIndex].hidden,
    });
  }
  if (observed.slides.length < 3)
    throw new Error("Not enough slides for structure transaction probe.");
  const firstSlideReference = observed.slides[0];
  const lastSlideReference = observed.slides.at(-1);
  const beforeSlideBatch = observed;
  const slideBatchCommands = [
    {
      op: "move_slide",
      slideIndex: lastSlideReference.slideIndex,
      targetSlideIndex: 0,
    },
    {
      op: "move_slide",
      slideIndex: firstSlideReference.slideIndex,
      targetSlideIndex: observed.slides.length - 1,
    },
  ];
  let slideTransactionEvidence;
  if (probePatchedEngine) {
    observed = await call({
      operation: "edit_batch",
      expectedRevision: observed.revision,
      expectedSlides: JSON.stringify(reorderObjectKeys(observed.slides)),
      commands: slideBatchCommands,
      dryRun: false,
      permission: { mode: "document", slideIndexes: [], elementIds: [] },
    });
    if (
      observed.transaction?.status !== "applied" ||
      observed.transaction?.undoActionsAdded !== 1
    )
      throw new Error(
        "Patched slide transaction was not committed as one undo action.",
      );
    const afterSlideBatch = observed;
    await dispatchHistory("undo");
    observed = await waitForDocumentState(
      beforeSlideBatch.revision,
      beforeSlideBatch,
      "patched slide transaction undo",
    );
    await dispatchHistory("redo");
    observed = await waitForDocumentState(
      afterSlideBatch.revision,
      afterSlideBatch,
      "patched slide transaction redo",
    );
    slideTransactionEvidence = {
      status: "applied",
      atomic: true,
      commandCount: slideBatchCommands.length,
      undoActionsAdded: 1,
    };
  } else {
    let slideTransactionError = null;
    try {
      await call({
        operation: "edit_batch",
        expectedRevision: observed.revision,
        expectedSlides: JSON.stringify(reorderObjectKeys(observed.slides)),
        commands: slideBatchCommands,
        dryRun: false,
        permission: { mode: "document", slideIndexes: [], elementIds: [] },
      });
    } catch (error) {
      slideTransactionError = error.message;
    }
    if (
      !slideTransactionError?.includes(
        "multi_slide_structure_transaction_requires_patched_engine",
      )
    )
      throw new Error(
        `Unsafe stock-engine slide transaction was not rejected: ${slideTransactionError}`,
      );
    observed = await call({ operation: "observe" });
    if (
      observed.revision !== beforeSlideBatch.revision ||
      firstDocumentStateDifference(beforeSlideBatch.slides, observed.slides)
    )
      throw new Error("Rejected slide transaction changed the document.");
    slideTransactionEvidence = {
      status: "rejected",
      atomic: true,
      commandCount: slideBatchCommands.length,
      reason: "patched_engine_required",
    };
  }
  const mixedTarget = observed.slides
    .flatMap((slide) => slide.elements)
    .find((element) => element.parentElementId === null);
  if (!mixedTarget)
    throw new Error("No element for mixed transaction rejection probe.");
  const beforeMixedBatch = observed;
  let mixedTransactionError = null;
  try {
    await call({
      operation: "edit_batch",
      expectedRevision: observed.revision,
      expectedSlides: JSON.stringify(reorderObjectKeys(observed.slides)),
      commands: [
        {
          op: "move_slide",
          slideIndex: 0,
          targetSlideIndex: 1,
        },
        {
          op: "move",
          elementId: mixedTarget.elementId,
          x: mixedTarget.x + 100,
          y: mixedTarget.y + 100,
        },
      ],
      dryRun: true,
      permission: { mode: "document", slideIndexes: [], elementIds: [] },
    });
  } catch (error) {
    mixedTransactionError = error.message;
  }
  if (
    !mixedTransactionError?.includes(
      "mixed_slide_structure_and_content_transaction",
    )
  )
    throw new Error(
      `Mixed structure/content transaction was not rejected: ${mixedTransactionError}`,
    );
  observed = await call({ operation: "observe" });
  if (
    observed.revision !== beforeMixedBatch.revision ||
    firstDocumentStateDifference(beforeMixedBatch.slides, observed.slides)
  )
    throw new Error("Rejected mixed transaction changed the document.");
  slideTransactionEvidence.mixedDomainStatus = "rejected";

  const nonActiveSlide = observed.slides.find(
    (slide) =>
      slide.slideIndex !== observed.activeSlide && slide.slideIndex !== 0,
  );
  if (!nonActiveSlide)
    throw new Error("No non-active slide for exact deletion probe.");
  await edit({ op: "delete_slide", slideIndex: nonActiveSlide.slideIndex });
  if (engineOperationAvailable("set_sections")) {
    const splitIndex = observed.slides.length > 1 ? 1 : null;
    await editWithUndoRoundTrip({
      op: "set_sections",
      sections: [
        {
          id: "{00000000-0000-4000-8000-000000000101}",
          name: "Spellbook opening",
          startSlideIndex: 0,
        },
        ...(splitIndex === null
          ? []
          : [
              {
                id: "{00000000-0000-4000-8000-000000000102}",
                name: "Spellbook detail",
                startSlideIndex: splitIndex,
              },
            ]),
      ],
    });
  }

  const transactionTarget = observed.slides[0].elements.find(
    (element) =>
      element.parentElementId === null &&
      String(element.kind).endsWith("RectangleShape"),
  );
  if (!transactionTarget)
    throw new Error("No rectangle target for transaction probe.");
  const transactionCommands = [
    {
      op: "move",
      elementId: transactionTarget.elementId,
      x: transactionTarget.x + 137,
      y: transactionTarget.y + 211,
    },
    {
      op: "resize",
      elementId: transactionTarget.elementId,
      width: transactionTarget.width + 173,
      height: transactionTarget.height + 97,
    },
  ];
  const beforeDryRun = observed;
  const dryRun = await call({
    operation: "edit_batch",
    expectedRevision: observed.revision,
    expectedSlides: JSON.stringify(reorderObjectKeys(observed.slides)),
    commands: transactionCommands,
    dryRun: true,
    permission: { mode: "document", slideIndexes: [], elementIds: [] },
  });
  if (
    dryRun.revision !== beforeDryRun.revision ||
    dryRun.transaction?.status !== "validated"
  )
    throw new Error("Native transaction dry-run changed the document.");

  const beforeRollback = dryRun;
  let rollbackError = "";
  try {
    await call({
      operation: "edit_batch",
      expectedRevision: dryRun.revision,
      expectedSlides: JSON.stringify(reorderObjectKeys(dryRun.slides)),
      commands: [
        {
          op: "move",
          elementId: transactionTarget.elementId,
          x: transactionTarget.x + 1000,
          y: transactionTarget.y + 1000,
        },
        {
          op: "delete_element",
          elementId: transactionTarget.elementId,
        },
        {
          op: "move",
          elementId: transactionTarget.elementId,
          x: transactionTarget.x + 1000,
          y: transactionTarget.y + 1000,
        },
      ],
      dryRun: false,
      permission: { mode: "document", slideIndexes: [], elementIds: [] },
    });
  } catch (error) {
    rollbackError = error.message;
  }
  if (!rollbackError)
    throw new Error(
      `Native transaction did not surface its forced failure: ${rollbackError || "no error"}`,
    );
  observed = await call({ operation: "observe" });
  if (observed.revision !== beforeRollback.revision)
    throw new Error(
      "Native transaction rollback did not restore its revision.",
    );

  observed = await call({
    operation: "edit_batch",
    expectedRevision: observed.revision,
    expectedSlides: JSON.stringify(reorderObjectKeys(observed.slides)),
    commands: transactionCommands,
    dryRun: false,
    permission: { mode: "document", slideIndexes: [], elementIds: [] },
  });
  if (
    observed.transaction?.status !== "applied" ||
    observed.transaction?.undoActionsAdded !== 1
  )
    throw new Error("Native transaction was not committed as one undo action.");
  const transactionEvidence = observed.transaction;
  const auditCandidates = observed.slides[0].elements.filter(
    (element) =>
      element.parentElementId === null &&
      !String(element.kind).endsWith("LineShape") &&
      element.width * element.height <
        observed.slides[0].width * observed.slides[0].height * 0.8,
  );
  const auditTarget = auditCandidates.find(
    (candidate) => candidate.stableId === transactionTarget.stableId,
  );
  const auditObstacle = auditCandidates.find(
    (candidate) =>
      candidate.elementId !== auditTarget?.elementId &&
      (candidate.x !== auditTarget?.x || candidate.y !== auditTarget?.y),
  );
  if (!auditTarget || !auditObstacle)
    throw new Error("Not enough objects for layout audit probe.");
  const beforeAudit = observed;
  const audited = await call({
    operation: "edit_batch",
    expectedRevision: observed.revision,
    expectedSlides: JSON.stringify(reorderObjectKeys(observed.slides)),
    commands: [
      {
        op: "move",
        elementId: auditTarget.elementId,
        x: auditObstacle.x,
        y: auditObstacle.y,
      },
    ],
    dryRun: false,
    permission: { mode: "document", slideIndexes: [], elementIds: [] },
  });
  if (
    !audited.layoutAudit?.introducedIssues?.some(
      (issue) => issue.code === "possible_element_overlap",
    )
  )
    throw new Error("Native layout audit missed a newly introduced overlap.");
  const layoutAuditEvidence = audited.layoutAudit;
  await dispatchHistory("undo");
  observed = await waitForDocumentState(
    beforeAudit.revision,
    beforeAudit,
    "layout audit rollback",
  );
  if (probePatchedEngine) {
    // Prefer a non-active slide so the patched-property and text-range paths
    // prove exact targeting without changing the user's current page.
    const propertySlideIndex =
      observed.slides.find(
        (slide) =>
          slide.slideIndex !== observed.activeSlide &&
          slide.elements.some(
            (element) =>
              element.parentElementId === null && Boolean(element.text),
          ),
      )?.slideIndex ?? observed.activeSlide;
    const activeSlideBeforePropertyObservation = observed.activeSlide;
    observed = await call({
      operation: "observe",
      detailSlideIndex: propertySlideIndex,
    });
    if (observed.activeSlide !== activeSlideBeforePropertyObservation)
      throw new Error("Property observation changed the active slide.");
    const preferredTextDetails =
      observed.textDetails?.elements.find(
        (element) =>
          /^\d+\/\d+$/.test(element.elementId) &&
          element.paragraphs.some(
            (paragraph) =>
              paragraph.portions.filter((portion) => portion.text.length > 0)
                .length > 1,
          ),
      ) ??
      observed.textDetails?.elements.find(
        (element) =>
          /^\d+\/\d+$/.test(element.elementId) &&
          element.paragraphs.some((paragraph) =>
            paragraph.portions.some((portion) => portion.text.length > 0),
          ),
      );
    const propertyTarget = observed.slides[propertySlideIndex]?.elements.find(
      (element) =>
        element.elementId === preferredTextDetails?.elementId &&
        element.parentElementId === null &&
        Boolean(element.text),
    );
    if (!propertyTarget)
      throw new Error("No top-level text object for property patch probe.");
    if (engineOperationAvailable("set_slide_metadata")) {
      const metadataSlide = observed.slides[propertySlideIndex];
      await editWithUndoRoundTrip({
        op: "set_slide_metadata",
        slideIndex: propertySlideIndex,
        slideMetadata: {
          footerVisible: true,
          footerText: "Spellbook verified",
          pageNumberVisible: true,
          dateTimeVisible: true,
          dateTimeFixed: true,
          dateTimeText: "2026-09-16",
          dateTimeFormat: 18,
          duration:
            metadataSlide.timing?.highResolutionDuration === 12.5 ? 7.25 : 12.5,
          backgroundObjectsVisible:
            metadataSlide.backgroundObjectsVisible === false,
        },
      });
    }
    if (engineOperationAvailable("set_line_style")) {
      const dashName = observed.styleCatalog?.lineDashNames?.find(
        (name) => name && name !== propertyTarget.lineDashName,
      );
      const markerNames = observed.styleCatalog?.lineMarkerNames ?? [];
      const startArrowName = markerNames.find(
        (name) => name && name !== propertyTarget.lineStartName,
      );
      const endArrowName = markerNames.find(
        (name) =>
          name &&
          name !== propertyTarget.lineEndName &&
          name !== startArrowName,
      );
      if (!dashName || !startArrowName || !endArrowName)
        throw new Error("Document line style catalog is incomplete.");
      await editWithUndoRoundTrip({
        op: "set_line_style",
        elementId: propertyTarget.elementId,
        lineStyle: { dashName, startArrowName, endArrowName },
      });
    }
    if (engineOperationAvailable("set_paragraph_format")) {
      const paragraph = propertyTarget.paragraphFormats?.[0];
      if (!paragraph)
        throw new Error("No observed paragraph for paragraph-format probe.");
      await editWithUndoRoundTrip({
        op: "set_paragraph_format",
        elementId: propertyTarget.elementId,
        paragraphId: paragraph.paragraphId,
        paragraphFormat: {
          leftMargin: Number(paragraph.leftMargin ?? 0) + 101,
          rightMargin: Number(paragraph.rightMargin ?? 0) + 37,
          firstLineIndent: Number(paragraph.firstLineIndent ?? 0) - 23,
          topMargin: Number(paragraph.topMargin ?? 0) + 19,
          bottomMargin: Number(paragraph.bottomMargin ?? 0) + 29,
          direction:
            paragraph.writingMode === "right-to-left"
              ? "left-to-right"
              : "right-to-left",
        },
      });
    }
    if (engineOperationAvailable("set_text_language"))
      await editWithUndoRoundTrip({
        op: "set_text_language",
        elementId: propertyTarget.elementId,
        languageTag:
          propertyTarget.wholeTextFormatting?.locale?.language === "ko"
            ? "en-US"
            : "ko-KR",
      });
    if (engineOperationAvailable("set_text_case"))
      await editWithUndoRoundTrip({
        op: "set_text_case",
        elementId: propertyTarget.elementId,
        textCase:
          Number(propertyTarget.wholeTextFormatting?.caseMap ?? 0) === 1
            ? "lowercase"
            : "uppercase",
      });
    if (engineOperationAvailable("set_paragraph_list")) {
      const paragraph = propertyTarget.paragraphFormats?.[0];
      if (!paragraph)
        throw new Error("No observed paragraph for list-format probe.");
      const listType = paragraph.list ? "none" : "bullet";
      await editWithUndoRoundTrip({
        op: "set_paragraph_list",
        elementId: propertyTarget.elementId,
        paragraphId: paragraph.paragraphId,
        paragraphList: {
          type: listType,
          level: 0,
          prefix: "",
          suffix: "",
          startWith: 1,
          bulletCharacter: listType === "bullet" ? "•" : null,
        },
      });
    }
    await editWithUndoRoundTrip({
      op: "set_alt_text",
      elementId: propertyTarget.elementId,
      title: "AI accessible title",
      description: "AI accessible description",
      decorative: false,
    });
    await editWithUndoRoundTrip({
      op: "set_text_box",
      elementId: propertyTarget.elementId,
      marginLeft: Number(propertyTarget.textMargins?.left ?? 0) + 17,
      marginRight: null,
      marginTop: null,
      marginBottom: null,
      autoGrowHeight: null,
      autoGrowWidth: null,
      wordWrap: null,
    });
    await editWithUndoRoundTrip({
      op: "set_character_spacing",
      elementId: propertyTarget.elementId,
      spacing: 1.25,
    });
    await editWithUndoRoundTrip({
      op: "set_script_position",
      elementId: propertyTarget.elementId,
      script: "superscript",
    });
    await editWithUndoRoundTrip({
      op: "set_shape_shadow",
      elementId: propertyTarget.elementId,
      shadow: true,
      color: 3368601,
      opacity: 63,
      shadowOffsetX: 240,
      shadowOffsetY: 260,
      shadowBlur: 80,
    });
    await editWithUndoRoundTrip({
      op: "set_shape_name",
      elementId: propertyTarget.elementId,
      name: "AI verified object",
    });
    if (probeTextRangeEngine) {
      const propertySlideIndex = Number(propertyTarget.elementId.split("/")[0]);
      observed = await call({
        operation: "observe",
        detailSlideIndex: propertySlideIndex,
      });
      const paragraph =
        observed.textDetails?.elements
          .find((element) => element.elementId === propertyTarget.elementId)
          ?.paragraphs.find(
            (candidate) =>
              candidate.text.length > 0 &&
              candidate.portions.filter((portion) => portion.text.length > 0)
                .length > 1,
          ) ??
        observed.textDetails?.elements
          .find((element) => element.elementId === propertyTarget.elementId)
          ?.paragraphs.find((candidate) => candidate.text.length > 0);
      if (!paragraph)
        throw new Error("No observed paragraph for text-range patch probe.");
      const firstPortion = paragraph.portions.find(
        (portion) => portion.text.length > 0,
      );
      if (!firstPortion)
        throw new Error("No observed run for text-range patch probe.");
      const expectedText = firstPortion.text.slice(0, 1);
      const rangeStart = firstPortion.startOffset;
      const rangeEnd = rangeStart + expectedText.length;
      const formattingBefore = Object.fromEntries(
        [
          "fontFamily",
          "fontFamilyAsian",
          "fontFamilyComplex",
          "fontSize",
          "fontSizeAsian",
          "fontSizeComplex",
          "fontWeight",
          "fontStyle",
          "underline",
          "strikethrough",
          "shadow",
          "color",
          "spacing",
          "escapement",
          "escapementHeight",
        ].map((key) => [key, firstPortion[key]]),
      );
      await editWithUndoRoundTrip({
        op: "replace_text_range",
        elementId: propertyTarget.elementId,
        paragraphId: paragraph.paragraphId,
        startOffset: rangeStart,
        endOffset: rangeEnd,
        expectedText,
        text: `${expectedText}R`,
      });
      const nextParagraph = observed.textDetails?.elements
        .find((element) => element.elementId === propertyTarget.elementId)
        ?.paragraphs.find(
          (candidate) => candidate.paragraphIndex === paragraph.paragraphIndex,
        );
      const formattedPortion = nextParagraph?.portions.find(
        (portion) =>
          portion.startOffset <= rangeStart && portion.endOffset > rangeStart,
      );
      if (!formattedPortion)
        throw new Error("Text-range replacement has no observable text run.");
      const formattingAfter = Object.fromEntries(
        Object.keys(formattingBefore).map((key) => [
          key,
          formattedPortion[key],
        ]),
      );
      if (JSON.stringify(formattingAfter) !== JSON.stringify(formattingBefore))
        throw new Error(
          `Text-range replacement changed run formatting: ${JSON.stringify({ formattingBefore, formattingAfter })}`,
        );
      textRangePersistence = {
        objectName: "AI verified object",
        slideIndex: propertySlideIndex,
        paragraphIndex: paragraph.paragraphIndex,
        text: nextParagraph.text,
        rangeStart,
        portionText: formattedPortion.text,
        formatting: formattingAfter,
      };
    }
    if (engineOperationAvailable("set_object_lock"))
      await editWithUndoRoundTrip({
        op: "set_object_lock",
        elementId: propertyTarget.elementId,
        lockPosition: true,
        lockSize: true,
      });
  }
  const expectedCommands = expectedOperations
    ? [...new Set(expectedOperations)].sort()
    : Object.entries(nativeEditContract.mutationModel.operations)
        .filter(([operationName, operation]) => {
          if (!engineOperationAvailable(operationName)) return false;
          const fixture =
            nativeEditContract.mutationModel.families[operation.family].fixture;
          const scenarios =
            nativeConformanceContract.fixtures[fixture]?.scenarios ?? [];
          return (
            scenarios.includes("general-native-surface") ||
            (probeTableStructureEngine && scenarios.includes("table-structure"))
          );
        })
        .map(([operation]) => operation)
        .sort();
  const verifiedCommands = [...new Set(results)].sort();
  if (JSON.stringify(verifiedCommands) !== JSON.stringify(expectedCommands)) {
    throw new Error(
      `Native capability drift: expected ${JSON.stringify(expectedCommands)}, verified ${JSON.stringify(verifiedCommands)}`,
    );
  }
  const propertyObject = observed.slides
    .flatMap((slide) => slide.elements)
    .find((element) => element.objectName === "AI verified object");
  const propertyTextDetails = observed.textDetails?.elements?.find(
    (element) => element.elementId === propertyObject?.elementId,
  );
  const verificationExpected = probePatchedEngine
    ? {
        backgroundColor: observed.slides[0].backgroundColor,
        speakerNotes: observed.slides
          .map((slide) => slide.speakerNotes?.text)
          .find((text) => text === "AI와 사용자가 함께 확인하는 발표자 노트"),
        tableCell: observed.slides
          .flatMap((slide) => slide.elements)
          .find((element) => element.table)?.table?.cells?.[1]?.[1],
        tableStructure: probeTableStructureEngine
          ? (() => {
              const persistedTable = observed.slides
                .flatMap((slide) => slide.elements)
                .find((element) => element.table);
              return persistedTable
                ? {
                    x: persistedTable.x,
                    y: persistedTable.y,
                    width: persistedTable.width,
                    height: persistedTable.height,
                    rows: persistedTable.table.rows,
                    columns: persistedTable.table.columns,
                    rowHeights: persistedTable.table.rowHeights,
                    columnWidths: persistedTable.table.columnWidths,
                    mergedRanges: persistedTable.table.mergedRanges,
                    cells: persistedTable.table.cells,
                  }
                : null;
            })()
          : null,
        namedSlide: observed.slides.find(
          (slide) => slide.name === "AI 검증 슬라이드",
        ),
        propertyObject,
        activeTextFonts: activeTextFontEvidence(propertyTextDetails),
        textRange: textRangePersistence,
      }
    : null;
  const textDetailElements = observed.textDetails?.elements ?? [];
  const textDetailSummary = {
    slideIndex: observed.textDetails?.slideIndex ?? null,
    elementCount: textDetailElements.length,
    paragraphCount: textDetailElements.reduce(
      (total, element) => total + element.paragraphs.length,
      0,
    ),
    portionCount: textDetailElements.reduce(
      (total, element) =>
        total +
        element.paragraphs.reduce(
          (paragraphTotal, paragraph) =>
            paragraphTotal + paragraph.portions.length,
          0,
        ),
      0,
    ),
  };
  await requestNativeProbeSave(page);
  const report = {
    commands: results,
    uniqueCommandCount: verifiedCommands.length,
    contractVersion: nativeEditContract.version,
    slideCount: observed.slides.length,
    elementCount: observed.slides[0].elements.length,
    textDetails: textDetailSummary,
    slideTransaction: slideTransactionEvidence,
    transaction: transactionEvidence,
    layoutAudit: layoutAuditEvidence,
    save: { acknowledged: true },
    persistenceBefore,
    persistenceExpected: persistenceStateFromObservation(observed),
    verificationExpected,
  };
  if (reportPath)
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx",
    });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await captureNativeSnapshots(page, "general-native-surface");
  await browser.close();
}
