import assert from "node:assert/strict";
import test from "node:test";

import {
  acknowledgedSaveHasLaterChanges,
  createSaveSnapshot,
  journalRecoveryDisposition,
  laterHistoryFromSaveSnapshot,
} from "./save-transaction.mjs";

test("recovery distinguishes unsaved work from a save acknowledged before journal cleanup", () => {
  const oldHash = "a".repeat(64);
  const savedHash = "b".repeat(64);
  const unrelatedHash = "c".repeat(64);
  const checkpoint = {
    metadata: { baseSha256: oldHash, candidateSha256: savedHash },
  };
  assert.equal(journalRecoveryDisposition(oldHash, checkpoint), "replay");
  assert.equal(
    journalRecoveryDisposition(savedHash, checkpoint),
    "already_saved",
  );
  assert.equal(
    journalRecoveryDisposition(unrelatedHash, checkpoint),
    "conflict",
  );
  assert.throws(() => journalRecoveryDisposition("invalid", checkpoint));
  assert.throws(() =>
    journalRecoveryDisposition(oldHash, { metadata: { baseSha256: oldHash } }),
  );
});

test("save acknowledgement compares the sent snapshot, not the current buffer reference", () => {
  const bytes = Uint8Array.from([0x50, 0x4b, 1]);
  const snapshot = createSaveSnapshot(bytes, "revision-1");
  bytes[2] = 2;
  assert.deepEqual(snapshot.bytes, Uint8Array.from([0x50, 0x4b, 1]));
  assert.equal(
    acknowledgedSaveHasLaterChanges(
      snapshot,
      Uint8Array.from([0x50, 0x4b, 1]),
      "revision-1",
    ),
    false,
  );
  assert.equal(
    acknowledgedSaveHasLaterChanges(snapshot, bytes, "revision-2"),
    true,
  );
  assert.equal(
    acknowledgedSaveHasLaterChanges(snapshot, bytes, "revision-1"),
    true,
  );
  assert.equal(
    acknowledgedSaveHasLaterChanges(snapshot, snapshot.bytes, "revision-2"),
    true,
  );
});

test("a save keeps only the later, byte-contiguous undo history", () => {
  const saved = Uint8Array.from([0x50, 0x4b, 1]);
  const first = Uint8Array.from([0x50, 0x4b, 2]);
  const second = Uint8Array.from([0x50, 0x4b, 3]);
  const prior = { op: "prior" };
  const edit1 = { op: "edit-1" };
  const edit2 = { op: "edit-2" };
  const snapshot = createSaveSnapshot(saved, "revision-1", 1, 1);
  const commands = [prior, edit1, edit2];
  const history = [
    { command: prior },
    {
      command: edit1,
      beforeBytes: saved,
      afterBytes: first,
      beforeRevision: "revision-1",
      afterRevision: "revision-2",
    },
    {
      command: edit2,
      beforeBytes: first,
      afterBytes: second,
      beforeRevision: "revision-2",
      afterRevision: "revision-3",
    },
  ];
  assert.deepEqual(
    laterHistoryFromSaveSnapshot(
      snapshot,
      second,
      "revision-3",
      commands,
      history,
    ),
    { commands: [edit1, edit2], undoHistory: history.slice(1) },
  );
  assert.equal(
    laterHistoryFromSaveSnapshot(snapshot, second, "revision-3", commands, [
      history[0],
      { ...history[1], beforeBytes: first },
      history[2],
    ]),
    null,
  );
  assert.equal(
    laterHistoryFromSaveSnapshot(snapshot, second, "revision-3", [prior], []),
    null,
  );
});
