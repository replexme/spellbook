import assert from "node:assert/strict";
import test from "node:test";

import {
  acknowledgedSaveHasLaterChanges,
  canReuseSaveAcknowledgementObservation,
  createSaveSnapshot,
  journalSnapshotFromSavedBase,
  journalRecoveryDisposition,
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

test("save acknowledgement reuses its read only when the engine state stayed still", () => {
  const stable = {
    observation: { revision: "saved" },
    documentChanges: 7,
    markSaved: { documentChangesBefore: 7, documentChangesAfter: 8 },
    status: { documentChanges: 8, modified: false },
    reconciledRevision: "saved",
  };
  assert.equal(canReuseSaveAcknowledgementObservation(stable), true);
  assert.equal(
    canReuseSaveAcknowledgementObservation({
      ...stable,
      documentChanges: null,
    }),
    false,
  );
  assert.equal(
    canReuseSaveAcknowledgementObservation({
      ...stable,
      status: { documentChanges: 9, modified: false },
    }),
    false,
  );
  assert.equal(
    canReuseSaveAcknowledgementObservation({
      ...stable,
      status: { documentChanges: 8, modified: true },
    }),
    false,
  );
  assert.equal(
    canReuseSaveAcknowledgementObservation({
      ...stable,
      markSaved: { documentChangesBefore: 8, documentChangesAfter: 9 },
      status: { documentChanges: 9, modified: false },
    }),
    false,
  );
  assert.equal(
    canReuseSaveAcknowledgementObservation({
      ...stable,
      reconciledRevision: "later-edit",
    }),
    false,
  );
});

test("session Undo after save becomes a new recoverable delta without erasing Undo history", () => {
  const saved = Uint8Array.from([0x50, 0x4b, 2]);
  const undone = Uint8Array.from([0x50, 0x4b, 1]);
  assert.deepEqual(
    journalSnapshotFromSavedBase({
      baseBytes: saved,
      currentBytes: undone,
      baseRevision: "saved-revision",
      currentRevision: "undone-revision",
      reason: "undo",
    }),
    {
      op: "native_snapshot",
      persistence: "native_snapshot",
      sourceOperations: ["undo"],
      reason: "undo",
      reconciliation: {
        beforeRevision: "saved-revision",
        afterRevision: "undone-revision",
        nativeRequest: null,
      },
    },
  );
  assert.equal(
    journalSnapshotFromSavedBase({
      baseBytes: saved,
      currentBytes: saved.slice(),
      baseRevision: "saved-revision",
      currentRevision: "saved-revision",
      reason: "redo",
    }),
    null,
  );
  // Undo by reopening the saved package gives the live model a new revision;
  // the identical bytes are still the saved document.
  assert.equal(
    journalSnapshotFromSavedBase({
      baseBytes: saved,
      currentBytes: saved.slice(),
      baseRevision: "saved-revision",
      currentRevision: "reopened-revision",
      reason: "undo",
    }),
    null,
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
