import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_STORAGE_RESERVE_BYTES = 512 * 1024 * 1024;
const MIN_STORAGE_RESERVE_BYTES = 64 * 1024 * 1024;
const MAX_STORAGE_RESERVE_BYTES = 1024 * 1024 * 1024 * 1024;

export class StorageCapacityError extends Error {
  constructor() {
    super("storage_capacity_exhausted");
  }
}

export function storageReserveBytes(
  value = process.env.SPELLBOOK_STORAGE_RESERVE_BYTES,
): number {
  if (value === undefined || value.trim() === "")
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

export function hasStorageCapacity(
  availableBytes: number,
  writeBytes: number,
  reserveBytes: number,
): boolean {
  return (
    Number.isSafeInteger(availableBytes) &&
    Number.isSafeInteger(writeBytes) &&
    Number.isSafeInteger(reserveBytes) &&
    availableBytes - writeBytes >= reserveBytes
  );
}

export function accountPrefix(accountId: string, documentId: string): string {
  const accountKey = Buffer.from(accountId).toString("base64url");
  return `accounts/${accountKey}/documents/${documentId}`;
}

export function storageNamespace(): string {
  return process.env.SPELLBOOK_STORAGE_NAMESPACE?.trim() || "local";
}

export async function putObject(
  objectName: string,
  data: Buffer,
  _contentType: string,
): Promise<void> {
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
    await fs.writeFile(temporary, data, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, destination);
  } catch (error) {
    if (hasCode(error, "ENOSPC")) throw new StorageCapacityError();
    throw error;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function getObject(objectName: string): Promise<Buffer> {
  return fs.readFile(/* turbopackIgnore: true */ objectPath(objectName));
}

export async function deleteObject(objectName: string): Promise<void> {
  await fs.rm(objectPath(objectName), { force: true });
}

/** Removes everything stored for one document: uploads, versions, previews and assets. */
export async function deleteDocumentObjects(
  accountId: string,
  documentId: string,
): Promise<void> {
  await fs.rm(objectPath(accountPrefix(accountId, documentId)), {
    recursive: true,
    force: true,
  });
}

/**
 * A short-lived link the browser can use to read an object straight from
 * storage. Local disk storage has none, so files pass through the app.
 */
export async function directReadUrl(
  _objectName: string,
  _download: { fileName: string; contentType: string },
): Promise<string | null> {
  return null;
}

/**
 * A short-lived link the browser can use to write one object straight to
 * storage, with the headers it must send. Local disk storage has none.
 */
export async function directWriteTarget(
  _objectName: string,
  _contentType: string,
  _maxBytes: number,
): Promise<{ url: string; headers: Record<string, string> } | null> {
  return null;
}

/** An object's size and first bytes, without reading the whole object. */
export async function objectHead(
  objectName: string,
  length: number,
): Promise<{ size: number; head: Buffer } | null> {
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

export async function getJsonObject<T>(objectName: string): Promise<T> {
  return JSON.parse((await getObject(objectName)).toString("utf8")) as T;
}

export function objectPath(objectName: string): string {
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

function storageRoot(): string {
  return path.resolve(
    /* turbopackIgnore: true */
    process.env.SPELLBOOK_DATA_DIR?.trim() || ".spellbook/data",
  );
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
