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

/**
 * Asks the AI worker about one account's subscription connection. A Claude
 * sign-in waits in one worker instance for its code, so the instance's
 * routing cookie is handed out and sent back with the code.
 */
export async function callAiAccount(
  path: string,
  account: { accountId: string; email: string },
  options: {
    body?: Record<string, unknown>;
    cookie?: string;
    onCookie?: (cookie: string) => void;
    timeoutMs?: number;
  } = {},
): Promise<unknown> {
  const response = await internalFetch(`${workerUrl("ai")}${path}`, {
    method: "POST",
    headers: options.cookie ? { cookie: options.cookie } : undefined,
    body: JSON.stringify({
      ...options.body,
      accountId: account.accountId,
      email: account.email,
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  if (cookie) options.onCookie?.(cookie);
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
