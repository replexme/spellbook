export type WopiMutation = "LOCK" | "REFRESH_LOCK" | "UNLOCK";

/** Return the existing lock on conflict (including an empty lock), or null on success. */
export function wopiLockConflict(
  operation: WopiMutation,
  current: string | null,
  given: string,
  oldLock: string | null,
): string | null {
  if (operation === "LOCK")
    return current && current !== given && current !== oldLock ? current : null;
  return current === given ? null : (current ?? "");
}
