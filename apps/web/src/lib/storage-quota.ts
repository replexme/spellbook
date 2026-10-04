/*
 * How much one account may keep, from its plan (account-plan.ts), and the
 * single rule for refusing a write. Over a limit, new imports and new saves
 * stop; opening, downloading, deleting and exporting keep working so a
 * person can always take their files out and make room.
 */
import type { AccountPlan } from "./account-plan";

/** Automatic saves kept per document (every plan); older ones are removed. */
export const AUTOSAVE_VERSIONS_KEPT = 20;

export interface StorageLimits {
  /** Bytes kept: imported files, saved versions, slide pictures and images. */
  bytes: number | null;
  documents: number | null;
}

/** The plan's limits, or null when it has none. */
export function storageLimits(
  plan: Pick<AccountPlan, "storageLimitBytes" | "documentLimit">,
): StorageLimits | null {
  if (plan.storageLimitBytes === null && plan.documentLimit === null)
    return null;
  return { bytes: plan.storageLimitBytes, documents: plan.documentLimit };
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
  if (
    write.newDocument &&
    limits.documents !== null &&
    usage.documents >= limits.documents
  )
    return "document_limit_reached";
  if (
    limits.bytes !== null &&
    usage.bytes + Math.max(0, write.addingBytes ?? 0) > limits.bytes
  )
    return "storage_full";
  return null;
}

/** True when nothing new fits: the page says so and offers a way out. */
export function storageFull(
  usage: StorageUsage,
  limits: StorageLimits | null,
): boolean {
  return (
    !!limits &&
    ((limits.bytes !== null && usage.bytes >= limits.bytes) ||
      (limits.documents !== null && usage.documents >= limits.documents))
  );
}

/** "312MB" or "1.2GB", as the settings page shows usage. */
export function storageAmount(bytes: number): string {
  const megabytes = bytes / 1024 / 1024;
  if (megabytes < 1024) return `${Math.ceil(megabytes)}MB`;
  const gigabytes = megabytes / 1024;
  return `${Number.isInteger(gigabytes) ? gigabytes : gigabytes.toFixed(1)}GB`;
}
