/* SPDX-License-Identifier: MPL-2.0 */

import { validateProductRecoveryHistory } from "./product-recovery-history.mjs";

const schemaVersion = 1;
const namespaceName = "spellbook-browser-office-v1";
const slots = ["a", "b"];
const maximumDocumentBytes = 64 * 1024 * 1024;
const maximumCommands = 500;

export async function requestPersistentBrowserStorage(
  storage = globalThis.navigator?.storage,
) {
  if (!storage?.persist) return false;
  return storage.persist();
}

export async function openBrowserDocumentJournal({
  identity,
  root,
  cryptoImpl = globalThis.crypto,
}) {
  if (
    typeof identity !== "string" ||
    !identity.trim() ||
    identity.length > 2_000
  )
    throw new TypeError("A bounded document identity is required.");
  if (!cryptoImpl?.subtle) throw new Error("Web Crypto is required.");
  const storageRoot =
    root ?? (await globalThis.navigator?.storage?.getDirectory?.());
  if (!storageRoot) throw new Error("OPFS is not available in this browser.");
  const namespace = await storageRoot.getDirectoryHandle(namespaceName, {
    create: true,
  });
  const key = await sha256(
    new TextEncoder().encode(identity.trim()),
    cryptoImpl,
  );
  const directory = await namespace.getDirectoryHandle(key, { create: true });

  async function load() {
    const candidates = await Promise.all(
      slots.map((slot) => loadSlot(directory, slot, cryptoImpl)),
    );
    return (
      candidates
        .filter(Boolean)
        .sort(
          (left, right) => right.metadata.generation - left.metadata.generation,
        )[0] ?? null
    );
  }

  return {
    load,
    async save({
      fileName,
      baseVersionId = null,
      baseBytes,
      candidateBytes,
      commands,
      artifactReceipt = null,
      commandGroups = null,
      appliedGroups = null,
      history = null,
      historyArtifacts = [],
    }) {
      validateBytes(baseBytes, "baseBytes");
      validateBytes(candidateBytes, "candidateBytes");
      validateProductRecoveryHistory(history, historyArtifacts);
      const safeCommands = cloneCommands(commands);
      const groupHistory = validateCommandGroups(
        commandGroups,
        appliedGroups,
        safeCommands,
      );
      const previous = await load();
      const generation = (previous?.metadata.generation ?? 0) + 1;
      const slot = slots[generation % slots.length];
      const baseSha256 = await sha256(baseBytes, cryptoImpl);
      const candidateSha256 = await sha256(candidateBytes, cryptoImpl);
      if (
        artifactReceipt &&
        (artifactReceipt.schemaVersion !== 1 ||
          artifactReceipt.candidateSha256 !== candidateSha256 ||
          typeof artifactReceipt.modelRevision !== "string" ||
          !artifactReceipt.modelRevision ||
          !/^[0-9a-f]{64}$/u.test(artifactReceipt.persistedStateSha256 ?? ""))
      )
        throw new Error(
          "Browser recovery artifact evidence does not match its bytes.",
        );
      for (const artifact of historyArtifacts) {
        validateBytes(artifact.bytes, "historyArtifact");
        if (
          (await sha256(artifact.bytes, cryptoImpl)) !==
          artifact.artifactReceipt.candidateSha256
        )
          throw Error("product_recovery_history_digest_mismatch");
      }
      const metadata = {
        schemaVersion,
        generation,
        fileName: validFileName(fileName),
        baseVersionId:
          typeof baseVersionId === "string" && baseVersionId
            ? baseVersionId
            : null,
        baseSha256,
        candidateSha256,
        commands: safeCommands,
        ...(history
          ? {
              productHistory: structuredClone(history),
              historyReceipts: historyArtifacts.map((a) =>
                structuredClone(a.artifactReceipt),
              ),
            }
          : {}),
        ...(groupHistory ?? {}),
        ...(artifactReceipt
          ? { artifactReceipt: structuredClone(artifactReceipt) }
          : {}),
        savedAt: new Date().toISOString(),
      };
      for (const artifact of historyArtifacts)
        await writeFile(
          directory,
          `history-${artifact.artifactReceipt.candidateSha256}-${slot}.pptx`,
          artifact.bytes,
        );
      await writeFile(directory, `base-${slot}.pptx`, baseBytes);
      await writeFile(directory, `candidate-${slot}.pptx`, candidateBytes);
      // Metadata is the commit record and is written last. If the browser dies
      // before this point, the other slot remains the newest valid checkpoint.
      await writeFile(
        directory,
        `metadata-${slot}.json`,
        new TextEncoder().encode(JSON.stringify(metadata)),
      );
      // Remove only obsolete files belonging to the overwritten slot, after
      // its new metadata is committed. The other generation stays recoverable.
      if (directory.entries)
        for await (const [name] of directory.entries()) {
          const match = /^history-([0-9a-f]{64})-([ab])\.pptx$/.exec(name);
          if (
            match?.[2] === slot &&
            !historyArtifacts.some(
              (a) => a.artifactReceipt.candidateSha256 === match[1],
            )
          )
            await removeFile(directory, name);
        }
      return metadata;
    },
    async clear() {
      if (directory.entries)
        for await (const [name] of directory.entries())
          if (/^history-[0-9a-f]{64}-[ab]\.pptx$/.test(name))
            await removeFile(directory, name);
      await Promise.all(
        slots.flatMap((slot) =>
          [
            `base-${slot}.pptx`,
            `candidate-${slot}.pptx`,
            `metadata-${slot}.json`,
          ].map((name) => removeFile(directory, name)),
        ),
      );
    },
  };
}

async function loadSlot(directory, slot, cryptoImpl) {
  try {
    const [metadataBytes, baseBytes, candidateBytes] = await Promise.all([
      readFile(directory, `metadata-${slot}.json`),
      readFile(directory, `base-${slot}.pptx`),
      readFile(directory, `candidate-${slot}.pptx`),
    ]);
    if (metadataBytes.byteLength > 1024 * 1024) return null;
    const metadata = JSON.parse(new TextDecoder().decode(metadataBytes));
    if (
      metadata.historyReceipts &&
      (!Array.isArray(metadata.historyReceipts) ||
        metadata.historyReceipts.length > 66)
    )
      return null;
    if (
      metadata?.schemaVersion !== schemaVersion ||
      !Number.isSafeInteger(metadata.generation) ||
      metadata.generation < 1 ||
      typeof metadata.baseSha256 !== "string" ||
      typeof metadata.candidateSha256 !== "string" ||
      !Array.isArray(metadata.commands) ||
      metadata.commands.length > maximumCommands
    )
      return null;
    validateCommandGroups(
      metadata.commandGroups ?? null,
      metadata.appliedGroups ?? null,
      metadata.commands,
    );
    validateBytes(baseBytes, "baseBytes");
    validateBytes(candidateBytes, "candidateBytes");
    if (
      (await sha256(baseBytes, cryptoImpl)) !== metadata.baseSha256 ||
      (await sha256(candidateBytes, cryptoImpl)) !== metadata.candidateSha256
    )
      return null;
    const historyArtifacts = [];
    for (const receipt of metadata.historyReceipts ?? []) {
      if (!/^[0-9a-f]{64}$/.test(receipt?.candidateSha256)) return null;
      const bytes = await readFile(
        directory,
        `history-${receipt.candidateSha256}-${slot}.pptx`,
      );
      validateBytes(bytes, "historyArtifact");
      if ((await sha256(bytes, cryptoImpl)) !== receipt.candidateSha256)
        return null;
      historyArtifacts.push({ bytes, artifactReceipt: receipt });
    }
    validateProductRecoveryHistory(metadata.productHistory, historyArtifacts);
    return { metadata, baseBytes, candidateBytes, historyArtifacts };
  } catch {
    return null;
  }
}

function validateBytes(value, name) {
  if (!(value instanceof Uint8Array) || !value.byteLength)
    throw new TypeError(`${name} must be a non-empty Uint8Array.`);
  if (value.byteLength > maximumDocumentBytes)
    throw new Error(`${name} exceeds the browser persistence limit.`);
}

function cloneCommands(commands) {
  if (!Array.isArray(commands) || commands.length > maximumCommands)
    throw new TypeError(
      `commands must contain at most ${maximumCommands} items.`,
    );
  const encoded = JSON.stringify(commands);
  if (encoded.length > 256 * 1024)
    throw new Error("Browser edit history exceeds the persistence limit.");
  return JSON.parse(encoded);
}

function validFileName(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 255)
    throw new TypeError("fileName must contain from 1 to 255 characters.");
  return value;
}

async function sha256(bytes, cryptoImpl) {
  const digest = await cryptoImpl.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function readFile(directory, name) {
  const handle = await directory.getFileHandle(name);
  return new Uint8Array(await (await handle.getFile()).arrayBuffer());
}

async function writeFile(directory, name, bytes) {
  const handle = await directory.getFileHandle(name, { create: true });
  const stream = await handle.createWritable();
  try {
    await stream.write(bytes);
    await stream.close();
  } catch (error) {
    await stream.abort?.().catch(() => undefined);
    throw error;
  }
}

async function removeFile(directory, name) {
  try {
    await directory.removeEntry(name);
  } catch (error) {
    if (error?.name !== "NotFoundError") throw error;
  }
}

function validateCommandGroups(groups, appliedGroups, commands) {
  if (groups === null) return null;
  if (
    !Array.isArray(groups) ||
    groups.length > maximumCommands ||
    !Number.isSafeInteger(appliedGroups) ||
    appliedGroups < 0 ||
    appliedGroups > groups.length ||
    groups.some((g) => !Array.isArray(g) || !g.length)
  )
    throw Error("Browser recovery command groups are invalid.");
  const safeGroups = JSON.parse(JSON.stringify(groups));
  cloneCommands(safeGroups.flat());
  if (
    JSON.stringify(safeGroups.slice(0, appliedGroups).flat()) !==
    JSON.stringify(commands)
  )
    throw Error(
      "Browser recovery command groups do not match the applied commands.",
    );
  return { commandGroups: safeGroups, appliedGroups };
}
