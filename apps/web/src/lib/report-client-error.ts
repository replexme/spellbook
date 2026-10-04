/**
 * Sends an error that a page caught (and so the browser never saw) to the
 * operator's error tracker. The self-hosted product keeps it in the browser
 * console; the managed service replaces this file with its tracker.
 */
export function reportClientError(error: unknown): void {
  console.error(error);
}
