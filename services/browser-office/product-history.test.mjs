import assert from "node:assert/strict";
import test from "node:test";

import {
  snapshotProductEditState,
  trimSessionProductHistory,
} from "./product-history.mjs";

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
