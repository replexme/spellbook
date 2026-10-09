/// <reference types="node" />
export class StorageCapacityError extends Error {}
export function storageReserveBytes(value?: string): number;
export function hasStorageCapacity(
  availableBytes: number,
  writeBytes: number,
  reserveBytes: number,
): boolean;
export function accountPrefix(accountId: string, documentId: string): string;
export function storageNamespace(): string;
export function putObject(
  objectName: string,
  data: Buffer,
  contentType: string,
): Promise<void>;
export function putObjectIfAbsent(
  objectName: string,
  data: Buffer,
  contentType: string,
): Promise<boolean>;
export function getObject(objectName: string): Promise<Buffer>;
export function deleteObject(objectName: string): Promise<void>;
export function deleteDocumentObjects(
  accountId: string,
  documentId: string,
): Promise<void>;
export function directReadUrl(
  objectName: string,
  download: { fileName: string; contentType: string },
): Promise<string | null>;
export function directWriteTarget(
  objectName: string,
  contentType: string,
  maxBytes: number,
): Promise<{ url: string; headers: Record<string, string> } | null>;
export function objectHead(
  objectName: string,
  length: number,
): Promise<{ size: number; head: Buffer } | null>;
export function objectDigest(
  objectName: string,
  headLength: number,
): Promise<{ size: number; head: Buffer; sha256: string } | null>;
export function moveObject(from: string, to: string): Promise<void>;
export function prefixBytes(prefix: string): Promise<number>;
export function deletePrefix(prefix: string): Promise<void>;
export function getJsonObject<T>(objectName: string): Promise<T>;
export function objectPath(objectName: string): string;
