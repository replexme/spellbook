import { createRequire } from "node:module";
import { probeEnginePatchVersion } from "./probe-engine-patch.mjs";
import { requestNativeProbeSave } from "./probe-save.mjs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { verifySlideshowPlayback } from "./slideshow-playback.mjs";
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
const persistedTransition = (transition) => ({
  type: transition?.type,
  subtype: transition?.subtype,
  direction: transition?.direction,
  duration: transition?.duration,
  fadeColor: transition?.fadeColor,
});

try {
  page = await browser.newPage({
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
        cool.callRemote(function spellbookSlideTransitionHistory(value) {
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
  if (probeEnginePatchVersion(before.engine?.patchLevel) < 7)
    throw new Error("The slide-transition engine candidate is unavailable.");
  if (!before.slides.length) throw new Error("No slide is available.");

  const firstEffect =
    before.slides[0].transition.type === 37 ? "push-from-left" : "fade";
  const firstExpected =
    firstEffect === "fade"
      ? {
          type: 37,
          subtype: 101,
          direction: true,
          duration: 0.75,
          fadeColor: 0,
        }
      : {
          type: 35,
          subtype: 97,
          direction: true,
          duration: 0.75,
          fadeColor: 0,
        };
  const historyBefore = await history();
  const after = await edit(before, [
    {
      op: "set_slide_transition",
      slideIndex: 0,
      transitionEffect: firstEffect,
      transitionDuration: 0.75,
    },
  ]);
  const historyAfter = await history();
  if (
    stable(persistedTransition(after.slides[0].transition)) !==
      stable(firstExpected) ||
    after.transaction?.status !== "applied" ||
    after.transaction?.commandCount !== 1 ||
    after.transaction?.undoActionsAdded !== 1 ||
    historyAfter.undo.length !== historyBefore.undo.length + 1
  )
    throw new Error("Slide transition did not apply exactly and atomically.");
  await history("undo");
  await waitForState(before, "Slide transition Undo");
  await history("redo");
  const firstRedone = await waitForState(after, "Slide transition Redo");

  const batchHistoryBefore = await history();
  const batchAfter = await edit(firstRedone, [
    {
      op: "set_slide_transition",
      slideIndex: 0,
      transitionEffect: "wipe-left-to-right",
      transitionDuration: 1,
    },
    {
      op: "set_slide_transition",
      slideIndex: 0,
      transitionEffect: "push-from-bottom",
      transitionDuration: 1.25,
    },
  ]);
  const batchExpected = {
    type: 35,
    subtype: 100,
    direction: true,
    duration: 1.25,
    fadeColor: 0,
  };
  const batchHistoryAfter = await history();
  if (
    stable(persistedTransition(batchAfter.slides[0].transition)) !==
      stable(batchExpected) ||
    batchAfter.transaction?.status !== "applied" ||
    batchAfter.transaction?.commandCount !== 2 ||
    batchAfter.transaction?.undoActionsAdded !== 1 ||
    batchHistoryAfter.undo.length !== batchHistoryBefore.undo.length + 1
  )
    throw new Error("Slide-transition batch was not one exact transaction.");
  await history("undo");
  await waitForState(firstRedone, "Slide-transition batch Undo");
  await history("redo");
  const redone = await waitForState(batchAfter, "Slide-transition batch Redo");

  const playback = await verifySlideshowPlayback(page, {
    kind: "transition",
    slideIndex: 0,
    durationSeconds: 1.25,
  });

  await requestNativeProbeSave(page);
  const report = {
    enginePatchLevel: redone.engine.patchLevel,
    operation: "set_slide_transition",
    atomic: true,
    batchAtomic: true,
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
  await captureNativeSnapshots(page, "slide-transition");
  await browser.close();
}
