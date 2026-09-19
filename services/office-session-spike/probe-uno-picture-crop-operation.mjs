import { createRequire } from "node:module";
import { requestNativeProbeSave } from "./probe-save.mjs";
import { revisionDocumentState } from "./document-state-evidence.mjs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");
const url = process.argv[2] ?? "http://localhost:3194";
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
        cool.callRemote(function spellbookPictureProbeHistory(value) {
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
          JSON.stringify(revisionDocumentState(current)) !==
          JSON.stringify(revisionDocumentState(expected))
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
      (element) => element.parentElementId === null && element.picture?.crop,
    );
  if (!target)
    throw new Error("No observable top-level picture in the probe deck.");

  const crop = { left: 0.15, top: 0.1, right: 0.08, bottom: 0.06 };
  const moved = { x: target.x + 100, y: target.y + 100 };
  const after = await call({
    operation: "edit_batch",
    expectedRevision: before.revision,
    expectedSlides: JSON.stringify(before.slides),
    commands: [
      { op: "crop_image", elementId: target.elementId, ...crop },
      { op: "move", elementId: target.elementId, ...moved },
    ],
    dryRun: false,
    permission: { mode: "document", slideIndexes: [], elementIds: [] },
  });
  const afterTarget = after.slides
    .flatMap((slide) => slide.elements)
    .find((element) => element.stableId === target.stableId);
  if (
    !afterTarget?.picture ||
    afterTarget.x !== moved.x ||
    afterTarget.y !== moved.y ||
    after.revision === before.revision ||
    after.transaction?.status !== "applied" ||
    after.transaction?.commandCount !== 2 ||
    after.transaction?.undoActionsAdded !== 1
  )
    throw new Error("Picture crop and move did not apply atomically.");
  const cropPropertyByEdge = {
    left: "Left",
    top: "Top",
    right: "Right",
    bottom: "Bottom",
  };
  for (const [edge, value] of Object.entries(crop)) {
    // GraphicCrop is stored in integer 1/100 mm. Compare with the exact
    // representable fraction for this source image instead of the unquantized
    // request, so the same rule holds for small and large source dimensions.
    const dimension = ["left", "right"].includes(edge)
      ? target.picture.sourceSize.width
      : target.picture.sourceSize.height;
    const expectedFraction =
      Math.round((Math.round(dimension * value) / dimension) * 1e6) / 1e6;
    if (
      afterTarget.graphicCrop[cropPropertyByEdge[edge]] !==
        Math.round(dimension * value) ||
      afterTarget.picture.crop[edge] !== expectedFraction
    )
      throw new Error(
        `Picture crop ${edge} differs: expected ${expectedFraction}, got ${afterTarget.picture.crop[edge]}`,
      );
  }

  await dispatchHistory("undo");
  await waitForRevision(before.revision, before, "Picture crop Undo");
  await dispatchHistory("redo");
  const redone = await waitForRevision(
    after.revision,
    after,
    "Picture crop Redo",
  );
  await page.waitForTimeout(1_000);
  await waitForRevision(after.revision, after, "Settled picture crop");

  if (process.env.SPELLBOOK_PROBE_SCREENSHOT) {
    const image = redone.images?.[0];
    if (!image?.pngBytes?.length)
      throw new Error("Picture crop did not return a verification image.");
    await writeFile(
      path.resolve(process.env.SPELLBOOK_PROBE_SCREENSHOT),
      Buffer.from(image.pngBytes),
    );
  }
  await requestNativeProbeSave(page);

  const report = {
    enginePatchLevel: redone.engine?.patchLevel,
    operation: "crop_image",
    multiCommandBatchAtomic: true,
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
        graphicCrop: afterTarget.graphicCrop,
        picture: afterTarget.picture,
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
