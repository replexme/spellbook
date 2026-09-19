/* SPDX-License-Identifier: MPL-2.0 */

function sameBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
}

export function journalRecoveryDisposition(hostSha256, checkpoint) {
  if (!/^[0-9a-f]{64}$/u.test(hostSha256 ?? ""))
    throw new TypeError("The host document digest is invalid.");
  const base = checkpoint?.metadata?.baseSha256;
  const candidate = checkpoint?.metadata?.candidateSha256;
  if (
    !/^[0-9a-f]{64}$/u.test(base ?? "") ||
    !/^[0-9a-f]{64}$/u.test(candidate ?? "")
  )
    throw new TypeError("The browser recovery checkpoint is invalid.");
  if (base === hostSha256) return "replay";
  // The server accepted the candidate, then the browser stopped before its
  // local journal was cleared. There is no unsaved delta to replay.
  if (candidate === hostSha256) return "already_saved";
  return "conflict";
}

export function createSaveSnapshot(bytes, modelRevision) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength)
    throw new TypeError("A save requires PPTX bytes.");
  if (typeof modelRevision !== "string" || !modelRevision)
    throw new TypeError("A save requires the observed model revision.");
  return { bytes: bytes.slice(), modelRevision };
}

export function acknowledgedSaveHasLaterChanges(
  snapshot,
  currentBytes,
  currentModelRevision,
) {
  if (!(snapshot?.bytes instanceof Uint8Array))
    throw new TypeError("The acknowledged save has no byte snapshot.");
  if (!(currentBytes instanceof Uint8Array) || !currentBytes.byteLength)
    throw new TypeError("The current PPTX bytes are missing.");
  if (typeof currentModelRevision !== "string" || !currentModelRevision)
    throw new TypeError("The current model revision is missing.");
  return (
    currentModelRevision !== snapshot.modelRevision ||
    !sameBytes(snapshot.bytes, currentBytes)
  );
}

export function journalSnapshotFromSavedBase({
  baseBytes,
  currentBytes,
  baseRevision,
  currentRevision,
  reason,
}) {
  if (!(baseBytes instanceof Uint8Array) || !baseBytes.byteLength)
    throw new TypeError("The saved PPTX base is missing.");
  if (!(currentBytes instanceof Uint8Array) || !currentBytes.byteLength)
    throw new TypeError("The current PPTX is missing.");
  if (
    typeof baseRevision !== "string" ||
    !baseRevision ||
    typeof currentRevision !== "string" ||
    !currentRevision ||
    typeof reason !== "string" ||
    !reason
  )
    throw new TypeError("A journal snapshot needs bounded revision identity.");
  // Identical bytes are the saved document itself, even when a package
  // reopen gave the live model a different revision than the one saved.
  if (sameBytes(baseBytes, currentBytes)) return null;
  return {
    op: "native_snapshot",
    persistence: "native_snapshot",
    sourceOperations: [reason],
    reason,
    reconciliation: {
      beforeRevision: baseRevision,
      afterRevision: currentRevision,
      nativeRequest: null,
    },
  };
}
