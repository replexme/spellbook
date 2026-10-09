/// <reference types="node" />
export interface LinkedImageReceipt {
  ownerPart: string;
  relationshipPart: string;
  relationshipId: string;
  url: string;
  consumers: number;
  width: number;
  height: number;
  contentType: string;
  extension: string;
  sha256: string;
  byteLength: number;
  linkIdentity: string;
}
export interface LinkedImageManifest {
  schemaVersion: 1;
  accountId: string;
  documentId: string;
  sourceSha256: string;
  images: LinkedImageReceipt[];
  skipped: Array<Record<string, unknown>>;
}
export function readOwnedLinkedImages(scope: {
  accountId: string;
  documentId: string;
  sourceSha256: string;
  objectStore: SnapshotObjectStore;
}): Promise<{
  manifest: LinkedImageManifest;
  assets: Array<LinkedImageReceipt & { sourceSha256: string; bytes: Buffer }>;
}>;
export function readLinkedImageManifest(scope: {
  accountId: string;
  documentId: string;
  sourceSha256: string;
  objectStore: SnapshotObjectStore;
}): Promise<LinkedImageManifest>;
export function readOwnedLinkedImage(
  scope: {
    accountId: string;
    documentId: string;
    sourceSha256: string;
    objectStore: SnapshotObjectStore;
  },
  sha256: string,
): Promise<LinkedImageReceipt & { sourceSha256: string; bytes: Buffer }>;

export interface SnapshotObjectStore {
  accountPrefix(accountId: string, documentId: string): string;
  getObject(objectName: string): Promise<Buffer>;
  objectHead(
    objectName: string,
    length: number,
  ): Promise<{ size: number; head: Buffer } | null>;
}
