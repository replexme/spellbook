import { createRequire } from "node:module";
import { requestNativeProbeSave } from "./probe-save.mjs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { verifySlideshowPlayback } from "./slideshow-playback.mjs";

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
        cool.callRemote(function presentAnimationTimingHistory(value) {
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
      if (
        stable(observed.slides) === stable(expected.slides) &&
        stable(observed.masters) === stable(expected.masters)
      )
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
  const observedEffects = (state) =>
    state.slides.flatMap((slide) => slide.animations?.effects ?? []);
  const commandFor = (effect, changes) => ({
    op: "set_animation_timing",
    elementId: effect.elementId,
    animationId: effect.animationId,
    duration: changes.duration,
    delay: changes.delay,
    start: changes.start,
  });
  const applyExactly = async (state, command, label) => {
    const historyBefore = await history();
    const applied = await edit(state, [command]);
    const historyAfter = await history();
    if (
      applied.transaction?.status !== "applied" ||
      applied.transaction?.commandCount !== 1 ||
      applied.transaction?.undoActionsAdded !== 1 ||
      historyAfter.undo.length !== historyBefore.undo.length + 1
    )
      throw new Error(`${label} was not one exact native transaction.`);
    await history("undo");
    await waitForState(state, `${label} Undo`);
    await history("redo");
    return waitForState(applied, `${label} Redo`);
  };

  const before = await call({ operation: "observe" });
  const patchLevelMatch = /^undo-v([1-9][0-9]*)$/.exec(
    before.engine?.patchLevel ?? "",
  );
  if (!patchLevelMatch || Number(patchLevelMatch[1]) < 8)
    throw new Error("The animation-timing engine candidate is unavailable.");
  const effects = observedEffects(before).filter(
    (effect) =>
      effect.elementId &&
      effect.animationId &&
      typeof effect.duration === "number" &&
      typeof effect.preset?.id === "string",
  );
  if (effects.length < 2)
    throw new Error("Animation timing probe requires two observed effects.");

  const first = effects[0];
  const firstExpected = {
    duration: first.duration === 1.25 ? 1.5 : 1.25,
    delay: first.delay === 0.25 ? 0.5 : 0.25,
    start: first.start === "after-previous" ? "on-click" : "after-previous",
  };
  const historyBefore = await history();
  const after = await edit(before, [commandFor(first, firstExpected)]);
  const historyAfter = await history();
  const changedFirst = observedEffects(after).find(
    (effect) => effect.animationId === first.animationId,
  );
  if (
    changedFirst?.duration !== firstExpected.duration ||
    changedFirst.delay !== firstExpected.delay ||
    changedFirst.start !== firstExpected.start ||
    after.transaction?.status !== "applied" ||
    after.transaction?.commandCount !== 1 ||
    after.transaction?.undoActionsAdded !== 1 ||
    historyAfter.undo.length !== historyBefore.undo.length + 1
  )
    throw new Error("Animation timing did not apply exactly and atomically.");
  await history("undo");
  await waitForState(before, "Animation timing Undo");
  await history("redo");
  const firstRedone = await waitForState(after, "Animation timing Redo");

  const redoneEffects = observedEffects(firstRedone);
  const batchTargets = [
    redoneEffects.find((effect) => effect.animationId === first.animationId),
    redoneEffects.find(
      (effect) => effect.animationId === effects[1].animationId,
    ),
  ];
  if (batchTargets.some((effect) => !effect))
    throw new Error("Animation effects changed identity after Redo.");
  const batchCommands = batchTargets.map((effect, index) =>
    commandFor(effect, {
      duration: index === 0 ? 0.75 : 1.5,
      delay: index === 0 ? 0 : 0.4,
      start: index === 0 ? "on-click" : "after-previous",
    }),
  );
  const batchHistoryBefore = await history();
  const batchAfter = await edit(firstRedone, batchCommands);
  const batchHistoryAfter = await history();
  if (
    batchAfter.transaction?.status !== "applied" ||
    batchAfter.transaction?.commandCount !== 2 ||
    batchAfter.transaction?.undoActionsAdded !== 1 ||
    batchHistoryAfter.undo.length !== batchHistoryBefore.undo.length + 1
  )
    throw new Error("Animation timing batch was not one exact transaction.");
  for (const command of batchCommands) {
    const effect = observedEffects(batchAfter).find(
      (candidate) => candidate.animationId === command.animationId,
    );
    if (
      effect?.duration !== command.duration ||
      effect.delay !== command.delay ||
      effect.start !== command.start
    )
      throw new Error("Animation timing batch readback is incomplete.");
  }
  await history("undo");
  await waitForState(firstRedone, "Animation timing batch Undo");
  await history("redo");
  let redone = await waitForState(batchAfter, "Animation timing batch Redo");

  const effectsBeforeAdd = observedEffects(redone);
  redone = await applyExactly(
    redone,
    {
      op: "add_animation_effect",
      elementId: effectsBeforeAdd[0].elementId,
      presetId: "ooo-entrance-appear",
      duration: 0.8,
      delay: 0.1,
      start: "after-previous",
      animationIndex: effectsBeforeAdd.length,
    },
    "Add animation effect",
  );
  const previousAnimationIds = new Set(
    effectsBeforeAdd.map((effect) => effect.animationId),
  );
  let lifecycleEffect = observedEffects(redone).find(
    (effect) => !previousAnimationIds.has(effect.animationId),
  );
  if (!lifecycleEffect)
    throw new Error("Added animation effect was not observable.");

  const replacementPreset =
    lifecycleEffect.preset.id === "ooo-entrance-wipe"
      ? "ooo-entrance-appear"
      : "ooo-entrance-wipe";
  const replacementIndex = lifecycleEffect.sequenceIndex;
  redone = await applyExactly(
    redone,
    {
      op: "replace_animation_effect",
      elementId: lifecycleEffect.elementId,
      animationId: lifecycleEffect.animationId,
      presetId: replacementPreset,
    },
    "Replace animation effect",
  );
  lifecycleEffect = observedEffects(redone)[replacementIndex];
  if (
    !lifecycleEffect ||
    lifecycleEffect.elementId !== effectsBeforeAdd[0].elementId ||
    lifecycleEffect.preset?.id !== replacementPreset
  )
    throw new Error("Replaced animation effect was not observable.");

  const moveTargetIndex = lifecycleEffect.sequenceIndex === 0 ? 1 : 0;
  redone = await applyExactly(
    redone,
    {
      op: "move_animation_effect",
      elementId: lifecycleEffect.elementId,
      animationId: lifecycleEffect.animationId,
      animationIndex: moveTargetIndex,
    },
    "Move animation effect",
  );
  lifecycleEffect = observedEffects(redone)[moveTargetIndex];
  if (
    !lifecycleEffect ||
    lifecycleEffect.elementId !== effectsBeforeAdd[0].elementId ||
    lifecycleEffect.preset?.id !== replacementPreset
  )
    throw new Error("Moved animation effect was not observable.");

  redone = await applyExactly(
    redone,
    {
      op: "remove_animation_effect",
      elementId: lifecycleEffect.elementId,
      animationId: lifecycleEffect.animationId,
    },
    "Remove animation effect",
  );
  if (observedEffects(redone).length !== effectsBeforeAdd.length)
    throw new Error("Animation effect removal did not restore the item count.");

  const playbackTarget = batchCommands[0];
  const playback = await verifySlideshowPlayback(page, {
    kind: "animation",
    slideIndex: Number(playbackTarget.elementId.split("/")[0]),
    presetId: batchTargets[0].preset.id,
    durationSeconds: playbackTarget.duration,
  });

  await requestNativeProbeSave(page);
  const report = {
    enginePatchLevel: redone.engine.patchLevel,
    commands: [
      "set_animation_timing",
      "add_animation_effect",
      "replace_animation_effect",
      "move_animation_effect",
      "remove_animation_effect",
    ],
    atomic: true,
    batchAtomic: true,
    undoExact: true,
    redoExact: true,
    effectCount: observedEffects(redone).length,
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
