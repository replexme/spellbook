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
  options: {
    body?: Record<string, unknown>;
    timeoutMs?: number;
  } = {},
): Promise<unknown> {
  const response = await internalFetch(`${workerUrl("ai")}${path}`, {
    method: "POST",
    body: JSON.stringify({
      ...options.body,
      accountId: account.accountId,
      email: account.email,
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  const body = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) throw new AiAccountError(response.status, body);
  return body;
}

/**
 * Opens a sign-in that runs inside one AI worker request and streams its
 * progress (lines of JSON). Ending `signal` ends the sign-in.
 */
export async function streamAiAccount(
  path: string,
  account: { accountId: string; email: string },
  options: { body?: Record<string, unknown>; signal: AbortSignal },
): Promise<Response> {
  const response = await internalFetch(`${workerUrl("ai")}${path}`, {
    method: "POST",
    body: JSON.stringify({
      ...options.body,
      accountId: account.accountId,
      email: account.email,
    }),
    signal: options.signal,
  });
  if (!response.ok)
    throw new AiAccountError(
      response.status,
      await response.json().catch(() => ({})),
    );
  return response;
}

export class AiAccountError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    const code =
      typeof (body as { error?: unknown })?.error === "string"
        ? (body as { error: string }).error
        : `ai_account_${status}`;
    super(code);
  }
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
