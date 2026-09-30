import type { AiConnectorConfig } from "./ai-connector-config";

export const LOCAL_CONNECTOR_SESSION_KEY = "spellbook.local-ai-session.v1";

export interface LocalConnectorSession {
  token: string;
  challenge: string;
  expiresAt: number;
}

interface PairingRuntime {
  fetch: typeof fetch;
  open(url: string, target: string, features: string): Window | null;
  addMessageListener(listener: (event: MessageEvent) => void): void;
  removeMessageListener(listener: (event: MessageEvent) => void): void;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  randomBytes(length: number): Uint8Array;
  setTimer(handler: () => void, milliseconds: number): number;
  clearTimer(id: number): void;
  now(): number;
}

export function localConnectorOrigin(
  config?: AiConnectorConfig,
): string | null {
  if (!config || config.mode === "internal") return null;
  return exactLoopbackOrigin(config.origin);
}

export function readLocalConnectorSession(
  storage: Pick<Storage, "getItem" | "removeItem">,
  now = Date.now(),
): LocalConnectorSession | null {
  const raw = storage.getItem(LOCAL_CONNECTOR_SESSION_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<LocalConnectorSession>;
    if (
      typeof value.token !== "string" ||
      value.token.length < 32 ||
      typeof value.challenge !== "string" ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt! <= now
    )
      throw new Error("invalid_local_connector_session");
    return value as LocalConnectorSession;
  } catch {
    storage.removeItem(LOCAL_CONNECTOR_SESSION_KEY);
    return null;
  }
}

export async function pairLocalConnector(
  connectorOrigin: string,
  intent: "codex" | "claude" = "codex",
  runtime = browserRuntime(),
): Promise<LocalConnectorSession> {
  const exactOrigin = exactLoopbackOrigin(connectorOrigin);
  const popup = runtime.open(
    "about:blank",
    "spellbook-local-ai-connector",
    "popup,width=520,height=680",
  );
  if (!popup) throw new Error("local_connector_popup_blocked");

  const challenge = base64Url(runtime.randomBytes(32));
  let timer = 0;
  let onMessage: ((event: MessageEvent) => void) | undefined;

  try {
    const response = await runtime.fetch(`${exactOrigin}/v1/pairings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge, intent }),
      cache: "no-store",
    });
    const value = (await response.json()) as { approvalUrl?: unknown };
    if (!response.ok || typeof value.approvalUrl !== "string")
      throw new Error("local_connector_unavailable");
    const approval = new URL(value.approvalUrl);
    if (
      approval.origin !== exactOrigin ||
      !/^\/pair\/[0-9a-f-]+$/i.test(approval.pathname) ||
      approval.search ||
      approval.hash
    )
      throw new Error("invalid_local_pairing_url");
    const paired = new Promise<LocalConnectorSession>((resolve, reject) => {
      const finish = (
        result: { value: LocalConnectorSession } | { error: Error },
      ) => {
        if (onMessage) runtime.removeMessageListener(onMessage);
        runtime.clearTimer(timer);
        if ("value" in result) resolve(result.value);
        else reject(result.error);
      };
      onMessage = (event) => {
        const value = event.data as Partial<LocalConnectorSession> & {
          type?: string;
        };
        if (
          event.origin !== exactOrigin ||
          event.source !== popup ||
          value?.type !== "spellbook.local-connector.paired"
        )
          return;
        if (
          value.challenge !== challenge ||
          typeof value.token !== "string" ||
          value.token.length < 32 ||
          !Number.isSafeInteger(value.expiresAt) ||
          value.expiresAt! <= runtime.now()
        )
          return finish({ error: new Error("invalid_local_pairing_response") });
        finish({
          value: {
            token: value.token,
            challenge,
            expiresAt: value.expiresAt!,
          },
        });
      };
      runtime.addMessageListener(onMessage);
      timer = runtime.setTimer(
        () => finish({ error: new Error("local_pairing_timed_out") }),
        2 * 60 * 1000,
      );
    });
    popup.location.replace(approval.href);
    const session = await paired;
    runtime.storage.setItem(
      LOCAL_CONNECTOR_SESSION_KEY,
      JSON.stringify(session),
    );
    return session;
  } catch (error) {
    popup.close();
    if (onMessage) runtime.removeMessageListener(onMessage);
    runtime.clearTimer(timer);
    throw error;
  }
}

export async function callLocalConnector<T>(
  connectorOrigin: string,
  path: string,
  session: LocalConnectorSession,
  body?: unknown,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const origin = exactLoopbackOrigin(connectorOrigin);
  if (!/^\/v1\/[a-z0-9/-]+$/.test(path))
    throw new Error("invalid_local_connector_path");
  const response = await fetcher(`${origin}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
  });
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(value.error || `local_connector_${response.status}`);
  return value;
}

function browserRuntime(): PairingRuntime {
  return {
    fetch: window.fetch.bind(window),
    open: window.open.bind(window),
    addMessageListener: (listener) =>
      window.addEventListener("message", listener),
    removeMessageListener: (listener) =>
      window.removeEventListener("message", listener),
    storage: window.sessionStorage,
    randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
    setTimer: (handler, milliseconds) =>
      window.setTimeout(handler, milliseconds),
    clearTimer: (id) => window.clearTimeout(id),
    now: Date.now,
  };
}

function exactLoopbackOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.origin !== value ||
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
  )
    throw new Error("invalid_local_connector_origin");
  return url.origin;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
