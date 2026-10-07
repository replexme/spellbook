const sent = new Set<string>();

/** Correlates a visible failure with server records without content or prompts. */
export function reportEditorError(
  documentId: string,
  errorReference: string,
  code: string,
  occurredAt: string,
): void {
  if (sent.has(errorReference)) return;
  sent.add(errorReference);
  if (sent.size > 100) sent.delete(sent.values().next().value!);
  try {
    void fetch(
      `/api/documents/${encodeURIComponent(documentId)}/editor-errors`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ errorReference, code, occurredAt }),
        keepalive: true,
        cache: "no-store",
      },
    ).catch(() => {
      sent.delete(errorReference);
    });
  } catch {
    sent.delete(errorReference);
  }
}
