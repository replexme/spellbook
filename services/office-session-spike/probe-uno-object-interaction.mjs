import { createRequire } from "node:module";
import { probeEnginePatchVersion } from "./probe-engine-patch.mjs";
import { requestNativeProbeSave } from "./probe-save.mjs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { verifySlideshowPlayback } from "./slideshow-playback.mjs";
import { undoDocumentStateEquivalent } from "./document-state-evidence.mjs";

const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const { chromium } = require("@playwright/test");
const url = process.argv[2] ?? "http://localhost:3190";
const reportPath = process.argv[3] ? path.resolve(process.argv[3]) : null;
const browser = await chromium.launch({ headless: true });
const stable = (value) => JSON.stringify(value);

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
  const history = (direction = null) => {
    const frame = page
      .frames()
      .find((candidate) =>
        candidate.url().includes("/extensions/org.spellbook.editor/"),
      );
    if (!frame) throw new Error("Native extension frame was lost.");
    return frame.evaluate(
      (requestedDirection) =>
        cool.callRemote(function spellbookObjectInteractionHistory(value) {
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
      if (undoDocumentStateEquivalent(expected, observed))
        return observed;
      await page.waitForTimeout(100);
    } while (Date.now() < stop);
    throw new Error(`${label} did not restore the exact document.`);
  };
  const edit = (observed, commands) =>
    call({
      operation: "edit_batch",
      expectedRevision: observed.revision,
      expectedSlides: stable(observed.slides),
      commands,
      dryRun: false,
      permission: { mode: "document", slideIndexes: [], elementIds: [] },
    });

  const before = await call({ operation: "observe" });
  if (probeEnginePatchVersion(before.engine?.patchLevel) < 18)
    throw new Error("The object-interaction engine candidate is unavailable.");
  if (before.slides.length < 2)
    throw new Error(
      "Object-interaction playback requires at least two slides.",
    );
  const target = before.slides[0].elements.find(
    (element) => element.parentElementId === null,
  );
  if (!target) throw new Error("No top-level interaction target is available.");

  const historyBefore = await history();
  const after = await edit(before, [
    {
      op: "set_object_interaction",
      elementId: target.elementId,
      interaction: "internal_slide",
      targetSlideIndex: 1,
    },
  ]);
  const historyAfter = await history();
  const changedTarget = after.slides[0].elements.find(
    (element) => element.elementId === target.elementId,
  );
  const expectedInteraction = {
    action: "internal_slide",
    url: null,
    targetSlideIndex: 1,
  };
  if (
    stable(changedTarget?.interaction) !== stable(expectedInteraction) ||
    after.transaction?.status !== "applied" ||
    after.transaction?.commandCount !== 1 ||
    after.transaction?.undoActionsAdded !== 1 ||
    historyAfter.undo.length !== historyBefore.undo.length + 1
  )
    throw new Error("Object interaction did not apply exactly and atomically.");

  await history("undo");
  await waitForState(before, "Object-interaction Undo");
  await history("redo");
  const redone = await waitForState(after, "Object-interaction Redo");

  const playback = await verifySlideshowPlayback(page, {
    kind: "interaction",
    slideIndex: 0,
    action: "bookmark",
    targetSlideIndex: 1,
  });

  await requestNativeProbeSave(page);
  const report = {
    enginePatchLevel: redone.engine.patchLevel,
    operation: "set_object_interaction",
    atomic: true,
    undoExact: true,
    redoExact: true,
    playback,
    persistenceBefore: {
      slides: before.slides,
      masters: before.masters,
    },
    persistenceExpected: {
      slides: redone.slides,
      masters: redone.masters,
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
