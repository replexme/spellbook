/* SPDX-License-Identifier: MPL-2.0 */
import { productHistoryLimits } from "./product-history.mjs";

// Persist approved packages for direct human edits, which cannot be replayed
// as model commands. Shared byte and entry limits apply to both histories.
export function captureProductRecoveryHistory(base, current, undo, redo) {
  const artifacts = new Map();
  const add = (state) => {
    const digest = state.receipt.candidateSha256;
    artifacts.set(digest, {
      bytes: state.bytes,
      artifactReceipt: state.receipt,
    });
    return digest;
  };
  add(base);
  add(current);
  const entry = (value) => ({
    before: add(value.before),
    after: add(value.after),
    commands: structuredClone(value.commands),
  });
  const history = {
    schemaVersion: 1,
    undo: undo.map(entry),
    redo: redo.map(entry),
  };
  return { history, historyArtifacts: [...artifacts.values()] };
}

export function validateProductRecoveryHistory(history, artifacts) {
  if (history === null || history === undefined) {
    if (artifacts?.length) throw Error("product_recovery_history_missing");
    return;
  }
  if (
    history.schemaVersion !== 1 ||
    !Array.isArray(history.undo) ||
    !Array.isArray(history.redo) ||
    history.undo.length + history.redo.length >
      productHistoryLimits.maxEntries ||
    !Array.isArray(artifacts)
  )
    throw Error("product_recovery_history_invalid");
  const hashes = new Set();
  let retained = 0;
  for (const artifact of artifacts) {
    const receipt = artifact.artifactReceipt;
    if (
      !(artifact.bytes instanceof Uint8Array) ||
      !artifact.bytes.length ||
      receipt?.schemaVersion !== 1 ||
      !/^[0-9a-f]{64}$/.test(receipt.candidateSha256) ||
      !/^[0-9a-f]{64}$/.test(receipt.persistedStateSha256) ||
      !receipt.modelRevision ||
      hashes.has(receipt.candidateSha256)
    )
      throw Error("product_recovery_history_artifact_invalid");
    hashes.add(receipt.candidateSha256);
    retained += artifact.bytes.byteLength;
  }
  if (retained > productHistoryLimits.maxBytes)
    throw Error("product_recovery_history_bytes_exceeded");
  for (const entry of [...history.undo, ...history.redo])
    if (
      !hashes.has(entry.before) ||
      !hashes.has(entry.after) ||
      !Array.isArray(entry.commands) ||
      !entry.commands.length
    )
      throw Error("product_recovery_history_entry_invalid");
  const chain = [...history.undo, ...history.redo.toReversed()];
  for (let index = 1; index < chain.length; index++)
    if (chain[index - 1].after !== chain[index].before)
      throw Error("product_recovery_history_not_contiguous");
}
