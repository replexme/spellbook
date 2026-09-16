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
