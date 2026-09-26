import assert from "node:assert/strict";
import test from "node:test";

import {
  reconcileNativeHistoryRevision,
  recordManualProductCheckpoint,
  snapshotProductEditState,
  trimSessionProductHistory,
} from "./product-history.mjs";

test("native Undo and Redo reuse exact journaled PPTX bytes", () => {
  const base = Uint8Array.of(1);
  const ai = Uint8Array.of(2);
  const typed = Uint8Array.of(3);
  const aiCommand = { op: "replace_text" };
  const manualCommand = { op: "native_snapshot" };
  const aiEntry = {
    command: aiCommand,
    beforeBytes: base,
    afterBytes: ai,
    beforeRevision: "base",
    afterRevision: "ai",
  };
  const manualEntry = {
    command: manualCommand,
    beforeBytes: ai,
    afterBytes: typed,
    beforeRevision: "ai",
    afterRevision: "typed",
  };
  const commands = [aiCommand, manualCommand];
  const undoHistory = [aiEntry, manualEntry];
  const redoHistory = [];
  const reconcile = (currentBytes, currentRevision, observedRevision) =>
    reconcileNativeHistoryRevision({
      commands,
      undoHistory,
      redoHistory,
      currentBytes,
      currentRevision,
      observedRevision,
    });
  assert.deepEqual(reconcile(typed, "typed", "ai"), {
    direction: "undo",
    bytes: ai,
  });
  assert.deepEqual(reconcile(ai, "ai", "base"), {
    direction: "undo",
    bytes: base,
  });
  assert.deepEqual(commands, []);
  assert.equal(redoHistory.length, 2);
  assert.deepEqual(reconcile(base, "base", "ai"), {
    direction: "redo",
    bytes: ai,
  });
  assert.deepEqual(reconcile(ai, "ai", "typed"), {
    direction: "redo",
    bytes: typed,
  });
  assert.deepEqual(commands, [aiCommand, manualCommand]);
  assert.deepEqual(
    undoHistory.map((entry) => entry.command),
    commands,
  );
});

test("native history cannot reuse a package when its bytes or revision differ", () => {
  const command = { op: "edit" };
  const undoHistory = [
    {
      command,
      beforeBytes: Uint8Array.of(1),
      afterBytes: Uint8Array.of(2),
      beforeRevision: "base",
      afterRevision: "edit",
    },
  ];
  const commands = [command];
  const redoHistory = [];
  const input = {
    commands,
    undoHistory,
    redoHistory,
    currentBytes: Uint8Array.of(9),
    currentRevision: "edit",
    observedRevision: "base",
  };
  assert.equal(reconcileNativeHistoryRevision(input), null);
  assert.equal(
    reconcileNativeHistoryRevision({
      ...input,
      currentBytes: Uint8Array.of(2),
      observedRevision: "other",
    }),
    null,
  );
  assert.equal(undoHistory.length, 1);
  assert.equal(commands.length, 1);
});

test("manual checkpoints preserve earlier AI Undo and coalesce continuous typing", () => {
  const aiBytes = Uint8Array.of(2);
  const firstManual = Uint8Array.of(3);
  const secondManual = Uint8Array.of(4);
  const aiCommand = { op: "replace_text" };
  const commands = [aiCommand];
  const aiEntry = { command: aiCommand, nativeUndoAvailable: true };
  const undoHistory = [aiEntry];
  const redoHistory = [{ command: { op: "old_redo" } }];
  recordManualProductCheckpoint({
    commands,
    undoHistory,
    redoHistory,
    beforeBytes: aiBytes,
    afterBytes: firstManual,
    beforeRevision: "ai",
    afterRevision: "manual-1",
    beforeSlides: [],
    reason: "manual_autosave",
  });
  assert.equal(undoHistory.length, 2);
  assert.equal(undoHistory[0], aiEntry);
  assert.equal(redoHistory.length, 0);
  recordManualProductCheckpoint({
    commands,
    undoHistory,
    redoHistory,
    beforeBytes: firstManual,
    afterBytes: secondManual,
    beforeRevision: "manual-1",
    afterRevision: "manual-2",
    beforeSlides: [],
    reason: "manual_save",
  });
  assert.equal(commands.length, 2);
  assert.equal(undoHistory.length, 2);
  assert.deepEqual(undoHistory[1].beforeBytes, aiBytes);
  assert.deepEqual(undoHistory[1].afterBytes, secondManual);
  assert.equal(undoHistory[1].beforeRevision, "ai");
  assert.equal(undoHistory[1].afterRevision, "manual-2");
  assert.equal(undoHistory[1].nativeUndoAvailable, false);
  assert.equal(undoHistory[1].nativeRequest, null);
});

test("a manual Undo returning to the checkpoint base removes only its aggregate", () => {
  const base = Uint8Array.of(1);
  const edited = Uint8Array.of(2);
  const commands = [];
  const undoHistory = [];
  const redoHistory = [];
  recordManualProductCheckpoint({
    commands,
    undoHistory,
    redoHistory,
    beforeBytes: base,
    afterBytes: edited,
    beforeRevision: "base",
    afterRevision: "edited",
    beforeSlides: [],
    reason: "manual_autosave",
  });
  const removed = recordManualProductCheckpoint({
    commands,
    undoHistory,
    redoHistory,
    beforeBytes: edited,
    afterBytes: base,
    beforeRevision: "edited",
    afterRevision: "base",
    beforeSlides: [],
    reason: "manual_undo",
  });
  assert.equal(removed, null);
  assert.deepEqual(commands, []);
  assert.deepEqual(undoHistory, []);
});

test("manual checkpoints reject a noncontiguous history", () => {
  const base = Uint8Array.of(1);
  const edited = Uint8Array.of(2);
  const commands = [];
  const undoHistory = [];
  const redoHistory = [];
  recordManualProductCheckpoint({
    commands,
    undoHistory,
    redoHistory,
    beforeBytes: base,
    afterBytes: edited,
    beforeRevision: "base",
    afterRevision: "edited",
    beforeSlides: [],
    reason: "manual_autosave",
  });
  assert.throws(
    () =>
      recordManualProductCheckpoint({
        commands,
        undoHistory,
        redoHistory,
        beforeBytes: Uint8Array.of(9),
        afterBytes: Uint8Array.of(3),
        beforeRevision: "edited",
        afterRevision: "later",
        beforeSlides: [],
        reason: "manual_save",
      }),
    /not contiguous/u,
  );
  assert.equal(commands.length, 1);
  assert.equal(undoHistory.length, 1);
});

test("a reopened package with a new live revision but the same bytes records nothing", () => {
  const base = Uint8Array.of(1);
  const commands = [];
  const undoHistory = [];
  const redoHistory = [{ command: { op: "stale_redo" } }];
  const recorded = recordManualProductCheckpoint({
    commands,
    undoHistory,
    redoHistory,
    beforeBytes: base,
    afterBytes: base.slice(),
    beforeRevision: "live-before-reopen",
    afterRevision: "reopened",
    beforeSlides: [],
    reason: "manual_autosave",
  });
  assert.equal(recorded, null);
  assert.deepEqual(commands, []);
  assert.deepEqual(undoHistory, []);
});

test("checkpoint rollback snapshot preserves redo and native availability flags", () => {
  const command = { op: "edit" };
  const undo = { nativeUndoAvailable: true };
  const redo = { nativeRedoAvailable: true };
  const state = {
    currentBytes: Uint8Array.of(1),
    currentSlideCount: 2,
    commands: [command],
    undoHistory: [undo],
    redoHistory: [redo],
    reconciledModelRevision: "before",
    unreconciledModelRevision: "",
    reconciledObservation: { revision: "before" },
  };
  const snapshot = snapshotProductEditState(state);
  state.commands.length = 0;
  undo.nativeUndoAvailable = false;
  state.redoHistory.length = 0;
  state.currentSlideCount = 3;
  assert.deepEqual(snapshot.commands, [command]);
  assert.equal(snapshot.undoHistory[0].nativeUndoAvailable, true);
  assert.equal(snapshot.redoHistory[0].nativeRedoAvailable, true);
  assert.equal(snapshot.currentSlideCount, 2);
});

test("session history keeps recent Undo and the next Redo within a byte budget", () => {
  const first = Uint8Array.of(1, 1, 1, 1);
  const second = Uint8Array.of(2, 2, 2, 2);
  const third = Uint8Array.of(3, 3, 3, 3);
  const fourth = Uint8Array.of(4, 4, 4, 4);
  const undoHistory = [
    { beforeBytes: first, afterBytes: second },
    { beforeBytes: second, afterBytes: third },
    { beforeBytes: third, afterBytes: fourth },
  ];
  const redoHistory = [];
  assert.equal(
    trimSessionProductHistory(undoHistory, redoHistory, {
      maxEntries: 3,
      maxBytes: 12,
    }),
    1,
  );
  assert.deepEqual(
    undoHistory.map((entry) => entry.afterBytes[0]),
    [3, 4],
  );
  redoHistory.push({ beforeBytes: fourth, afterBytes: first });
  assert.equal(
    trimSessionProductHistory(undoHistory, redoHistory, {
      maxEntries: 2,
      maxBytes: 12,
    }),
    1,
  );
  assert.equal(undoHistory.length, 1);
  assert.equal(redoHistory.length, 1);
});

test("session history always retains the latest Undo even for a large document", () => {
  const undoHistory = [
    { beforeBytes: Uint8Array.of(1), afterBytes: Uint8Array.of(2) },
  ];
  const redoHistory = [];
  assert.equal(
    trimSessionProductHistory(undoHistory, redoHistory, {
      maxEntries: 1,
      maxBytes: 1,
    }),
    0,
  );
  assert.equal(undoHistory.length, 1);
  assert.throws(() =>
    trimSessionProductHistory(undoHistory, redoHistory, { maxBytes: NaN }),
  );
});
