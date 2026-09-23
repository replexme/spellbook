export type WopiMutation = "LOCK" | "REFRESH_LOCK" | "UNLOCK";

/** Return the existing lock on conflict (including an empty lock), or null on success. */
export function wopiLockConflict(
  operation: WopiMutation,
  current: string | null,
  given: string,
  oldLock: string | null,
): string | null {
  if (operation === "LOCK") {
    // X-WOPI-OldLock changes LOCK into atomic UnlockAndRelock. Even if the
    // new lock matches, an absent/mismatched old lock is a conflict.
    if (oldLock !== null) return current === oldLock ? null : (current ?? "");
    return current && current !== given ? current : null;
  }
  return current === given ? null : (current ?? "");
}
