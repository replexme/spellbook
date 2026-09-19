import { createRequire } from "node:module";
import { probeEnginePatchVersion } from "./probe-engine-patch.mjs";
import { requestNativeProbeSave } from "./probe-save.mjs";
import { writeFile } from "node:fs/promises";
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
const stable = (value) => JSON.stringify(value);

let page;
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
        cool.callRemote(function spellbookLayoutHistory(value) {
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
      `${label} did not restore every slide and master exactly: ${JSON.stringify(
        historyStateDifference(expected, observed),
      )}`,
    );
  };

  const before = await call({ operation: "observe" });
  const patchVersion = probeEnginePatchVersion(before.engine?.patchLevel);
  if (patchVersion < 12)
    throw new Error("The slide-layout master repair is unavailable.");
  const slideIndex = before.activeSlide;
  const targetMaster = before.masters.find(
    (candidate) =>
      candidate.masterIndex !== before.slides[slideIndex].masterIndex,
  );
  if (!targetMaster) throw new Error("No alternate slide layout exists.");
  const { masterIndex, layout } = targetMaster;
  const historyBefore = await history();
  const after = await call({
    operation: "edit_batch",
    expectedRevision: before.revision,
    expectedSlides: stable(before.slides),
    commands: [{ op: "set_slide_layout", slideIndex, masterIndex, layout }],
    dryRun: false,
    permission: { mode: "document", slideIndexes: [], elementIds: [] },
  });
  const historyAfter = await history();
  if (stable(after.masters) !== stable(before.masters))
    throw new Error(
      "Slide-local layout selection changed the reusable master collection.",
    );
  if (
    after.slides[slideIndex].layout !== layout ||
    after.slides[slideIndex].masterIndex !== masterIndex ||
    after.slides[slideIndex].masterName !== targetMaster.name ||
    after.revision === before.revision ||
    after.transaction?.status !== "applied" ||
    after.transaction?.commandCount !== 1 ||
    after.transaction?.undoActionsAdded !== 1 ||
    historyAfter.undo.length !== historyBefore.undo.length + 1
  )
    throw new Error("Slide layout did not apply as one native Undo action.");

  await history("undo");
  await waitForState(before, "Slide layout Undo");
  await history("redo");
  let redone = await waitForState(after, "Slide layout Redo");
  const operations = ["set_slide_layout"];
  const editWithHistory = async (command) => {
    const prior = structuredClone(redone);
    const priorHistory = await history();
    const next = await call({
      operation: "edit_batch",
      expectedRevision: redone.revision,
      expectedSlides: stable(redone.slides),
      commands: [command],
      dryRun: false,
      permission: { mode: "document", slideIndexes: [], elementIds: [] },
    });
    const nextHistory = await history();
    if (
      next.revision === prior.revision ||
      next.transaction?.status !== "applied" ||
      next.transaction?.undoActionsAdded !== 1 ||
      nextHistory.undo.length !== priorHistory.undo.length + 1
    )
      throw new Error(
        `${command.op} did not apply as one native Undo action: ${JSON.stringify(
          {
            revisionChanged: next.revision !== prior.revision,
            transaction: next.transaction ?? null,
            undoBefore: priorHistory.undo.length,
            undoAfter: nextHistory.undo.length,
          },
        )}`,
      );
    await history("undo");
    await waitForState(prior, `${command.op} Undo`);
    await history("redo");
    redone = await waitForState(next, `${command.op} Redo`);
    operations.push(command.op);
  };
  if (patchVersion >= 22) {
    const currentWidth = redone.slides[0].width;
    const nextWidth =
      currentWidth < 99900 ? currentWidth + 100 : currentWidth - 100;
    await editWithHistory({
      op: "set_slide_size",
      width: nextWidth,
      height: redone.slides[0].height,
      scaleContent: false,
    });
    const currentTheme = redone.masters[masterIndex]?.theme;
    const colors =
      Array.isArray(currentTheme?.colors) && currentTheme.colors.length === 12
        ? [...currentTheme.colors]
        : [
            0x000000, 0xffffff, 0x222222, 0xeeeeee, 0x4472c4, 0xed7d31,
            0xa5a5a5, 0xffc000, 0x5b9bd5, 0x70ad47, 0x0563c1, 0x954f72,
          ];
    colors[4] = colors[4] === 0x4f46e5 ? 0x2563eb : 0x4f46e5;
    const text = (value, fallback) =>
      typeof value === "string" && value ? value : fallback;
    await editWithHistory({
      op: "set_master_theme",
      masterIndex,
      theme: {
        name:
          currentTheme?.name === "Spellbook verified theme"
            ? "Spellbook verified theme 2"
            : "Spellbook verified theme",
        colorSchemeName: text(
          currentTheme?.colorSchemeName,
          "Spellbook colors",
        ),
        colors,
        fontSchemeName: text(currentTheme?.fontSchemeName, "Spellbook fonts"),
        majorLatin: text(currentTheme?.majorLatin, "Liberation Sans"),
        majorAsian: text(currentTheme?.majorAsian, "Noto Sans CJK KR"),
        majorComplex: text(currentTheme?.majorComplex, "Noto Sans Arabic"),
        minorLatin: text(currentTheme?.minorLatin, "Liberation Sans"),
        minorAsian: text(currentTheme?.minorAsian, "Noto Sans CJK KR"),
        minorComplex: text(currentTheme?.minorComplex, "Noto Sans Arabic"),
      },
    });
  }

  if (process.env.SPELLBOOK_PROBE_SCREENSHOT) {
    const image = redone.images?.[0];
    if (!image?.pngBytes?.length)
      throw new Error("Slide layout returned no verification image.");
    await writeFile(
      path.resolve(process.env.SPELLBOOK_PROBE_SCREENSHOT),
      Buffer.from(image.pngBytes),
    );
  }
  await requestNativeProbeSave(page);

  const report = {
    enginePatchLevel: redone.engine.patchLevel,
    commands: operations,
    atomic: true,
    undoExact: true,
    redoExact: true,
    persistenceBefore: {
      slides: before.slides,
      masters: before.masters,
    },
    persistenceExpected: {
      slideIndex,
      masterIndex,
      masterName: targetMaster.name,
      layout,
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
  await captureNativeSnapshots(page, "layout-master");
  await browser.close();
}
