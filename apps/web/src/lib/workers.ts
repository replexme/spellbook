export type WorkerTarget = "document" | "ai";

export async function enqueueWorkerJob(
  _jobId: string,
  target: WorkerTarget,
  path: string,
  payload: unknown,
): Promise<void> {
  const response = await internalFetch(`${workerUrl(target)}${path}`, {
    method: "POST",
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(`Local worker request failed: ${response.status}`);
}

/** Asks the AI worker about one account's subscription connection. */
export async function callAiAccount(
  path: string,
  account: { accountId: string; email: string },
): Promise<unknown> {
  const response = await internalFetch(`${workerUrl("ai")}${path}`, {
    method: "POST",
    body: JSON.stringify({
      accountId: account.accountId,
      email: account.email,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json()) as unknown;
  if (!response.ok)
    throw new Error(
      `AI account request failed: ${response.status} ${JSON.stringify(body)}`,
    );
  return body;
}

async function internalFetch(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  const token = process.env.SPELLBOOK_INTERNAL_TOKEN?.trim();
  if (token) headers.set("x-spellbook-internal-token", token);
  return fetch(url, { ...init, headers });
}

function workerUrl(target: WorkerTarget): string {
  const value =
    target === "document"
      ? process.env.SPELLBOOK_DOCUMENT_WORKER_URL
      : process.env.SPELLBOOK_AI_WORKER_URL;
  if (!value?.trim())
    throw new Error(
      `SPELLBOOK_${target.toUpperCase()}_WORKER_URL is required.`,
    );
  return value.replace(/\/+$/, "");
}
