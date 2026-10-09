/* SPDX-License-Identifier: MPL-2.0 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
const DEFAULT_STORAGE_RESERVE_BYTES = 512 * 1024 * 1024;
const MIN_STORAGE_RESERVE_BYTES = 64 * 1024 * 1024;
const MAX_STORAGE_RESERVE_BYTES = 1024 * 1024 * 1024 * 1024;
class StorageCapacityError extends Error {
  constructor() {
    super("storage_capacity_exhausted");
  }
}
function storageReserveBytes(
  value = process.env.SPELLBOOK_STORAGE_RESERVE_BYTES,
) {
  if (value === void 0 || value.trim() === "")
    return DEFAULT_STORAGE_RESERVE_BYTES;
  const bytes = Number(value);
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < MIN_STORAGE_RESERVE_BYTES ||
    bytes > MAX_STORAGE_RESERVE_BYTES
  )
    throw new Error(
      `SPELLBOOK_STORAGE_RESERVE_BYTES must be an integer from ${MIN_STORAGE_RESERVE_BYTES} to ${MAX_STORAGE_RESERVE_BYTES}.`,
    );
  return bytes;
}
function hasStorageCapacity(availableBytes, writeBytes, reserveBytes) {
  return (
    Number.isSafeInteger(availableBytes) &&
    Number.isSafeInteger(writeBytes) &&
    Number.isSafeInteger(reserveBytes) &&
    availableBytes - writeBytes >= reserveBytes
  );
}
function accountPrefix(accountId, documentId) {
  const accountKey = Buffer.from(accountId).toString("base64url");
  return `accounts/${accountKey}/documents/${documentId}`;
}
function storageNamespace() {
  return process.env.SPELLBOOK_STORAGE_NAMESPACE?.trim() || "local";
}
async function putObject(objectName, data, _contentType) {
  const destination = objectPath(objectName);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const base = storageRoot();
  const capacity = await fs.statfs(base);
  const availableBytes = Number(capacity.bavail) * Number(capacity.bsize);
  if (
    !hasStorageCapacity(availableBytes, data.byteLength, storageReserveBytes())
  )
    throw new StorageCapacityError();
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, data, { flag: "wx", mode: 384 });
    await fs.rename(temporary, destination);
  } catch (error) {
    if (hasCode(error, "ENOSPC")) throw new StorageCapacityError();
    throw error;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => void 0);
  }
}
async function getObject(objectName) {
  return fs.readFile(
    /* turbopackIgnore: true */
    objectPath(objectName),
  );
}
async function deleteObject(objectName) {
  await fs.rm(objectPath(objectName), { force: true });
}
async function deleteDocumentObjects(accountId, documentId) {
  await fs.rm(objectPath(accountPrefix(accountId, documentId)), {
    recursive: true,
    force: true,
  });
}
async function directReadUrl(_objectName, _download) {
  return null;
}
async function directWriteTarget(_objectName, _contentType, _maxBytes) {
  return null;
}
async function objectHead(objectName, length) {
  const file = objectPath(objectName);
  const handle = await fs.open(file, "r").catch(() => null);
  if (!handle) return null;
  try {
    const { size } = await handle.stat();
    const head = Buffer.alloc(Math.min(length, size));
    await handle.read(head, 0, head.length, 0);
    return { size, head };
  } finally {
    await handle.close();
  }
}
async function objectDigest(objectName, headLength) {
  const file = objectPath(objectName);
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) return null;
  const hash = createHash("sha256");
  const chunks = [];
  let collected = 0;
  for await (const chunk of createReadStream(file)) {
    const data = chunk;
    hash.update(data);
    if (collected < headLength) {
      chunks.push(data.subarray(0, headLength - collected));
      collected += Math.min(data.length, headLength - collected);
    }
  }
  return {
    size: stat.size,
    head: Buffer.concat(chunks),
    sha256: hash.digest("hex"),
  };
}
async function moveObject(from, to) {
  const destination = objectPath(to);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(objectPath(from), destination);
}
async function prefixBytes(prefix) {
  return directoryBytes(objectPath(prefix.replace(/\/+$/, "")));
}
async function deletePrefix(prefix) {
  await fs.rm(objectPath(prefix.replace(/\/+$/, "")), {
    recursive: true,
    force: true,
  });
}
async function directoryBytes(directory) {
  const entries = await fs
    .readdir(directory, { withFileTypes: true })
    .catch((error) => {
      if (hasCode(error, "ENOENT")) return [];
      throw error;
    });
  let total = 0;
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(child);
    else if (entry.isFile()) total += (await fs.stat(child)).size;
  }
  return total;
}
async function getJsonObject(objectName) {
  return JSON.parse((await getObject(objectName)).toString("utf8"));
}
function objectPath(objectName) {
  if (
    !objectName ||
    objectName.startsWith("/") ||
    objectName.split("/").some((part) => part === ".." || part === ".")
  )
    throw new Error("Unsafe object name.");
  const base = storageRoot();
  const result = path.resolve(base, objectName);
  if (!result.startsWith(`${base}${path.sep}`))
    throw new Error("Unsafe object name.");
  return result;
}
function storageRoot() {
  return path.resolve(
    /* turbopackIgnore: true */
    process.env.SPELLBOOK_DATA_DIR?.trim() || ".spellbook/data",
  );
}
function hasCode(error, code) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
/** An immutable source manifest is published once, including racing producers. */
export async function putObjectIfAbsent(objectName, data, contentType) {
  const temporary = objectName + "." + randomUUID() + ".incoming";
  await putObject(temporary, data, contentType);
  try {
    const destination = objectPath(objectName);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    try {
      await fs.link(objectPath(temporary), destination);
      return true;
    } catch (error) {
      if (error.code === "EEXIST") return false;
      throw error;
    }
  } finally {
    await deleteObject(temporary);
  }
}

export {
  StorageCapacityError,
  accountPrefix,
  deleteDocumentObjects,
  deleteObject,
  deletePrefix,
  directReadUrl,
  directWriteTarget,
  getJsonObject,
  getObject,
  hasStorageCapacity,
  moveObject,
  objectDigest,
  objectHead,
  objectPath,
  prefixBytes,
  putObject,
  storageNamespace,
  storageReserveBytes,
};
