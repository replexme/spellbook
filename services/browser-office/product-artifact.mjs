/* SPDX-License-Identifier: MPL-2.0 */

import {
  normalizeDocumentPersistenceState,
  persistenceStateFromObservation,
} from "../office-session-spike/persistence-evidence.mjs";

function stateOf(observation) {
  return {
    ...normalizeDocumentPersistenceState(
      persistenceStateFromObservation(observation),
    ),
    sections: observation?.sections ?? [],
  };
}

async function sha256(bytes) {
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

// The same authority admits AI edits, direct edits, history, recovery and save.
// Inspection and intent verification happen before a digest/version pair is
// usable. A journal or a successful command is never itself admission evidence.
export function createProductArtifactAuthority({
  inspect,
  maximumEntries = 128,
}) {
  if (
    typeof inspect !== "function" ||
    !Number.isSafeInteger(maximumEntries) ||
    maximumEntries < 1
  )
    throw new TypeError(
      "An artifact authority requires an inspector and bounded retention.",
    );
  const admissions = new Map();
  const inspections = new Map();
  const saved = new Set();
  function retain(map, key, value, maximum) {
    map.delete(key);
    map.set(key, value);
    while (map.size > maximum) {
      const oldest = [...map.keys()].find(
        (candidate) => map !== admissions || !saved.has(candidate),
      );
      if (!oldest) break;
      map.delete(oldest);
    }
  }
  function snapshot(bytes) {
    if (
      !(bytes instanceof Uint8Array) ||
      !bytes.byteLength ||
      bytes.byteLength > 64 * 1024 * 1024
    )
      throw new TypeError("An artifact requires bounded document bytes.");
    return bytes.slice();
  }
  async function inspection(bytes, detailSlideIndex) {
    const captured = snapshot(bytes);
    const digest = await sha256(captured);
    const key = `${digest}:${detailSlideIndex ?? ""}`;
    let result = inspections.get(key);
    if (!result) {
      result = await inspect(captured, detailSlideIndex);
      if ((await sha256(captured)) !== digest)
        throw new Error("browser_artifact_changed_during_verification");
      if (!Array.isArray(result?.slides) || !result.slides.length)
        throw new Error("browser_artifact_inspection_missing");
      // Keep observations, never extra copies of potentially large packages.
      retain(inspections, key, structuredClone(result), 4);
    }
    if ((await sha256(bytes)) !== digest)
      throw new Error("browser_artifact_changed_during_verification");
    return { digest, observation: structuredClone(result) };
  }
  return {
    async inspect(bytes, detailSlideIndex) {
      return (await inspection(bytes, detailSlideIndex)).observation;
    },
    async admit({
      bytes,
      modelRevision,
      detailSlideIndex,
      verify,
      recoveredReceipt = null,
    }) {
      if (
        typeof modelRevision !== "string" ||
        !modelRevision ||
        typeof verify !== "function"
      )
        throw new Error("browser_artifact_intent_evidence_missing");
      const inspected = await inspection(bytes, detailSlideIndex);
      // Only real readback of the exact package can satisfy this callback.
      await verify(structuredClone(inspected.observation));
      if ((await sha256(bytes)) !== inspected.digest)
        throw new Error("browser_artifact_changed_during_verification");
      const persistedStateSha256 = await sha256(
        new TextEncoder().encode(
          JSON.stringify(canonical(stateOf(inspected.observation))),
        ),
      );
      const receipt = {
        schemaVersion: 1,
        candidateSha256: inspected.digest,
        modelRevision,
        detailSlideIndex: detailSlideIndex ?? null,
        persistedStateSha256,
      };
      if (
        recoveredReceipt &&
        (recoveredReceipt.schemaVersion !== 1 ||
          recoveredReceipt.candidateSha256 !== receipt.candidateSha256 ||
          recoveredReceipt.persistedStateSha256 !==
            receipt.persistedStateSha256)
      )
        throw new Error("browser_artifact_recovery_evidence_mismatch");
      retain(
        admissions,
        `${inspected.digest}:${modelRevision}`,
        receipt,
        maximumEntries,
      );
      return structuredClone(receipt);
    },
    async retainSave(bytes, modelRevision) {
      const key = `${await sha256(snapshot(bytes))}:${modelRevision}`;
      const receipt = admissions.get(key);
      if (!receipt) throw new Error("browser_artifact_not_verified");
      // Save ACK may arrive after many later edits. Pin that admitted pair
      // independently of the bounded history cache until the request ends.
      saved.add(key);
      return () => saved.delete(key);
    },
    async require(bytes, modelRevision) {
      const digest = await sha256(snapshot(bytes));
      const receipt = admissions.get(`${digest}:${modelRevision}`);
      if (!receipt) throw new Error("browser_artifact_not_verified");
      return structuredClone(receipt);
    },
    clear() {
      admissions.clear();
      inspections.clear();
      saved.clear();
    },
  };
}
