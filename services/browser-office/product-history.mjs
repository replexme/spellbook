/* SPDX-License-Identifier: MPL-2.0 */

const maximumEntries = 32;
const maximumRetainedBytes = 256 * 1024 * 1024;

export function snapshotProductEditState(state) {
  return {
    ...state,
    commands: state.commands.slice(),
    undoHistory: state.undoHistory.map((entry) => ({ ...entry })),
    redoHistory: state.redoHistory.map((entry) => ({ ...entry })),
  };
}

function sameBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
}

// A human can use the editor's own Undo/Redo instead of the product toolbar.
// When that reaches an already journaled revision, reuse its exact package.
// Re-exporting the engine's equivalent model can rewrite untouched masters.
export function reconcileNativeHistoryRevision({
  commands,
  undoHistory,
  redoHistory,
  currentBytes,
  currentRevision,
  observedRevision,
}) {
  if (!(currentBytes instanceof Uint8Array) || !observedRevision) return null;
  const lastUndo = undoHistory.at(-1);
  if (
    lastUndo &&
    lastUndo.beforeBytes instanceof Uint8Array &&
    lastUndo.afterBytes instanceof Uint8Array &&
    commands.at(-1) === lastUndo.command &&
    lastUndo.afterRevision === currentRevision &&
    lastUndo.beforeRevision === observedRevision &&
    sameBytes(lastUndo.afterBytes, currentBytes)
  ) {
    undoHistory.pop();
    commands.pop();
    redoHistory.push({
      ...lastUndo,
      nativeUndoAvailable: false,
      nativeRedoAvailable: false,
    });
    return { direction: "undo", bytes: lastUndo.beforeBytes.slice() };
  }
  const lastRedo = redoHistory.at(-1);
  if (
    lastRedo &&
    lastRedo.beforeBytes instanceof Uint8Array &&
    lastRedo.afterBytes instanceof Uint8Array &&
    lastRedo.beforeRevision === currentRevision &&
    lastRedo.afterRevision === observedRevision &&
    sameBytes(lastRedo.beforeBytes, currentBytes)
  ) {
    redoHistory.pop();
    commands.push(lastRedo.command);
    undoHistory.push({
      ...lastRedo,
      nativeUndoAvailable: false,
      nativeRedoAvailable: false,
    });
    return { direction: "redo", bytes: lastRedo.afterBytes.slice() };
  }
  return null;
}

export function recordManualProductCheckpoint({
  commands,
  undoHistory,
  redoHistory,
  beforeBytes,
  afterBytes,
  beforeRevision,
  afterRevision,
  beforeSlides,
  reason,
}) {
  if (
    !Array.isArray(commands) ||
    !Array.isArray(undoHistory) ||
    !Array.isArray(redoHistory) ||
    !(beforeBytes instanceof Uint8Array) ||
    !(afterBytes instanceof Uint8Array) ||
    !beforeBytes.byteLength ||
    !afterBytes.byteLength ||
    typeof beforeRevision !== "string" ||
    !beforeRevision ||
    typeof afterRevision !== "string" ||
    !afterRevision ||
    !Array.isArray(beforeSlides) ||
    typeof reason !== "string" ||
    !reason
  )
    throw new TypeError("A manual checkpoint needs complete edit identity.");

  const previousCommand = commands.at(-1);
  const coalesce =
    previousCommand?.persistence === "native_snapshot" &&
    previousCommand.sourceOperations?.length === 1 &&
    previousCommand.sourceOperations[0] === "manual_edit";
  const previousEntry = undoHistory.at(-1);
  if (
    coalesce &&
    (previousEntry?.command !== previousCommand ||
      !(previousEntry.beforeBytes instanceof Uint8Array) ||
      !(previousEntry.afterBytes instanceof Uint8Array) ||
      previousEntry.afterRevision !== beforeRevision ||
      !sameBytes(previousEntry.afterBytes, beforeBytes))
  )
    throw new Error("The manual checkpoint history is not contiguous.");

  const firstBytes = coalesce ? previousEntry.beforeBytes : beforeBytes;
  const firstRevision = coalesce
    ? previousEntry.beforeRevision
    : beforeRevision;
  // Identical bytes are the same persisted document. The live revision can
  // still differ after a package reopen, whose import normalizes details the
  // earlier live model had not; the caller has already proved that every
  // intended change is in these bytes, so there is nothing to record.
  if (sameBytes(firstBytes, afterBytes)) {
    if (coalesce) {
      commands.pop();
      undoHistory.pop();
    }
    redoHistory.length = 0;
    return null;
  }

  const command = {
    op: "native_snapshot",
    persistence: "native_snapshot",
    sourceOperations: ["manual_edit"],
    reason,
    reconciliation: {
      beforeRevision: firstRevision,
      afterRevision,
      nativeRequest: { operation: "manual_edit" },
    },
  };
  const entry = {
    beforeBytes: firstBytes,
    afterBytes,
    beforeRevision: firstRevision,
    afterRevision,
    beforeSlides: coalesce ? previousEntry.beforeSlides : beforeSlides,
    nativeRequest: null,
    command,
    persistence: "native_snapshot",
    nativeUndoAvailable: false,
    nativeRedoAvailable: false,
  };
  if (coalesce) {
    commands[commands.length - 1] = command;
    undoHistory[undoHistory.length - 1] = entry;
  } else {
    commands.push(command);
    undoHistory.push(entry);
  }
  redoHistory.length = 0;
  return command;
}

function retainedByteLength(undoHistory, redoHistory) {
  const buffers = new Set();
  let total = 0;
  for (const entry of [...undoHistory, ...redoHistory]) {
    for (const bytes of [entry.beforeBytes, entry.afterBytes]) {
      if (!(bytes instanceof Uint8Array) || buffers.has(bytes.buffer)) continue;
      buffers.add(bytes.buffer);
      total += bytes.byteLength;
    }
  }
  return total;
}

export function trimSessionProductHistory(
  undoHistory,
  redoHistory,
  { maxEntries = maximumEntries, maxBytes = maximumRetainedBytes } = {},
) {
  if (!Array.isArray(undoHistory) || !Array.isArray(redoHistory))
    throw new TypeError("Browser edit history must be arrays.");
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1
  )
    throw new TypeError("Browser edit history limits are invalid.");
  let removed = 0;
  while (
    (undoHistory.length + redoHistory.length > maxEntries ||
      retainedByteLength(undoHistory, redoHistory) > maxBytes) &&
    (undoHistory.length > 1 || redoHistory.length > 0)
  ) {
    if (undoHistory.length > 1) undoHistory.shift();
    else redoHistory.shift();
    removed += 1;
  }
  return removed;
}
