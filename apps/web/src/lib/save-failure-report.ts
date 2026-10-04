/**
 * Tells the server that the editor could not save, so failed edits are
 * counted even when the file never reached the server. Best effort: a
 * report that cannot be sent changes nothing for the person.
 */
export function reportSaveFailure(documentId: string, stage: string): void {
  try {
    void fetch(`/api/documents/${encodeURIComponent(documentId)}/save-failures`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage }),
      keepalive: true,
      cache: "no-store",
    }).catch(() => undefined);
  } catch {
    // Reporting must never affect editing.
  }
}
