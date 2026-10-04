/*
 * How much one account may keep. The single source for the limits: the
 * server enforces them and the pages state them.
 *
 * Over a limit, new imports and new saves stop; opening, downloading,
 * deleting and exporting keep working so a person can always take their
 * files out and make room.
 */

export type AccountPlan = "free" | "pro";

/** Automatic saves kept per document (every plan); older ones are removed. */
export const AUTOSAVE_VERSIONS_KEPT = 20;

export interface StorageLimits {
  /** Bytes kept: imported files, saved versions, slide pictures and images. */
  bytes: number;
  documents: number;
}

export const FREE_STORAGE_LIMITS: StorageLimits = {
  bytes: 1024 * 1024 * 1024,
  documents: 100,
};

/** Limits for a plan; null means the plan has no storage limit here. */
export function storageLimits(plan: AccountPlan): StorageLimits | null {
  return plan === "free" ? FREE_STORAGE_LIMITS : null;
}

export interface StorageUsage {
  bytes: number;
  documents: number;
}

export type StorageQuotaProblem = "storage_full" | "document_limit_reached";

/**
 * Why a write must be refused, or null when it fits. `newDocument` adds a
 * document; `addingBytes` is what the write is known to add.
 */
export function storageQuotaProblem(
  usage: StorageUsage,
  limits: StorageLimits | null,
  write: { newDocument?: boolean; addingBytes?: number } = {},
): StorageQuotaProblem | null {
  if (!limits) return null;
  if (write.newDocument && usage.documents >= limits.documents)
    return "document_limit_reached";
  if (usage.bytes + Math.max(0, write.addingBytes ?? 0) > limits.bytes)
    return "storage_full";
  return null;
}

/** "312MB" or "1.2GB", as the settings page shows usage. */
export function storageAmount(bytes: number): string {
  const megabytes = bytes / 1024 / 1024;
  if (megabytes < 1024) return `${Math.ceil(megabytes)}MB`;
  const gigabytes = megabytes / 1024;
  return `${Number.isInteger(gigabytes) ? gigabytes : gigabytes.toFixed(1)}GB`;
}
