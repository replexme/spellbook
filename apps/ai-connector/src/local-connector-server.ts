import { normalizeActiveGoal } from "../../../contracts/native-goal.cjs";
import { randomBytes } from "node:crypto";
import type {
  IncomingMessage,
  RequestListener,
  ServerResponse,
} from "node:http";

import type { LocalNativeTurns } from "./local-native-turns.js";
import type { LocalPairingAuthority } from "./local-pairing.js";
import type { LocalNativeJob, NativeJob } from "./types.js";

const MAX_BODY_BYTES = 16_384;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export interface LocalConnectorAccounts {
  status(identity: string): Promise<unknown>;
  startBrowserLogin(identity: string): Promise<unknown>;
  startClaudeBrowserLogin(): Promise<unknown>;
  startLogin(identity: string): Promise<unknown>;
  logout(identity: string): Promise<void>;
  models(identity: string): Promise<unknown>;
}

export interface LocalConnectorOptions {
  authority: LocalPairingAuthority;
  localTurns?: LocalNativeTurns;
  accounts: LocalConnectorAccounts;
  connectorOrigin: string;
  identity: string;
  runNativeJob(job: NativeJob, capability: string): void;
}

export function createLocalConnectorHandler(
  options: LocalConnectorOptions,
): RequestListener {
  const connectorOrigin = exactLoopbackOrigin(options.connectorOrigin);
  return (request, response) => {
    void handle(request, response, options, connectorOrigin).catch((error) => {
      const message =
        error instanceof Error ? error.message : "local_connector_error";
      const status = errorStatus(message);
      json(response, status, { error: message });
    });
  };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: LocalConnectorOptions,
  connectorOrigin: string,
): Promise<void> {
  assertHost(request, connectorOrigin);
  const url = new URL(request.url ?? "/", connectorOrigin);

  if (request.method === "GET" && url.pathname === "/health") {
    return json(response, 200, {
      status: "ok",
      mode: "local",
      protocolVersion: 1,
      capabilities: { localTurns: Boolean(options.localTurns) },
    });
  }

  if (request.method === "GET" && /^\/pair\/[^/]+$/.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.slice("/pair/".length));
    return approvalPage(
      response,
      options.authority.approval(id),
      connectorOrigin,
    );
  }

  if (
    request.method === "POST" &&
    /^\/pair\/[^/]+\/confirm$/.test(url.pathname)
  ) {
    requireLocalConfirmation(request, connectorOrigin);
    const id = decodeURIComponent(
      url.pathname.slice("/pair/".length, -"/confirm".length),
    );
    const form = await readForm(request);
    const session = options.authority.confirm(
      id,
      requiredString(form, "confirmationSecret"),
    );
    let authUrl: string | null = null;
    let loginStartFailed = false;
    if (session.intent === "codex") {
      try {
        const state = (await options.accounts.status(options.identity)) as {
          account?: { account?: { type?: string } | null } | null;
        };
        if (!state.account?.account) {
          const login = (await options.accounts.startBrowserLogin(
            options.identity,
          )) as { authUrl?: unknown };
          authUrl = safeAuthUrl(login.authUrl);
        }
      } catch {
        loginStartFailed = true;
      }
    } else {
      try {
        const state = (await options.accounts.status(options.identity)) as {
          claude?: { account?: unknown } | null;
        };
        if (!state.claude?.account)
          await options.accounts.startClaudeBrowserLogin();
      } catch {
        loginStartFailed = true;
      }
    }
    return pairedPage(
      response,
      session,
      connectorOrigin,
      authUrl,
      loginStartFailed,
      session.intent,
    );
  }

  const origin = requiredOrigin(request);
  options.authority.validateOrigin(origin);
  setCors(response, origin);
  if (request.method === "OPTIONS" && url.pathname.startsWith("/v1/")) {
    if (request.headers["access-control-request-private-network"] === "true")
      response.setHeader("access-control-allow-private-network", "true");
    response.writeHead(204, {
      "access-control-allow-methods": "POST",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-max-age": "600",
    });
    response.end();
    return;
  }
  if (request.method !== "POST")
    return json(response, 405, { error: "method_not_allowed" });

  if (url.pathname === "/v1/pairings") {
    const body = await readJson(request);
    const intent = body.intent ?? "codex";
    if (intent !== "codex" && intent !== "claude")
      throw new Error("invalid_pairing_intent");
    const pairing = options.authority.begin(
      origin,
      requiredString(body, "challenge"),
      intent,
    );
    return json(response, 201, {
      pairing,
      approvalUrl: `${connectorOrigin}/pair/${encodeURIComponent(pairing.id)}`,
    });
  }

  const token = bearerToken(request);
  options.authority.verify(origin, token);
  if (url.pathname === "/v1/pairings/revoke") {
    options.localTurns?.revoke(origin + ":" + token);
    options.authority.revoke(origin, token);
    return json(response, 200, { status: "disconnected" });
  }
  if (url.pathname === "/v1/account/status") {
    return json(response, 200, await options.accounts.status(options.identity));
  }
  if (url.pathname === "/v1/claude/login") {
    return json(
      response,
      200,
      await options.accounts.startClaudeBrowserLogin(),
    );
  }
  if (url.pathname === "/v1/account/login") {
    const body = await readJson(request);
    const method = body.method ?? "browser";
    if (method !== "browser" && method !== "device")
      throw new Error("invalid_login_method");
    return json(
      response,
      200,
      method === "browser"
        ? await options.accounts.startBrowserLogin(options.identity)
        : await options.accounts.startLogin(options.identity),
    );
  }
  if (url.pathname === "/v1/account/logout") {
    await options.accounts.logout(options.identity);
    options.localTurns?.revoke(origin + ":" + token);
    options.authority.revoke(origin, token);
    return json(response, 200, { status: "disconnected" });
  }
  if (url.pathname === "/v1/models") {
    return json(response, 200, {
      capabilities: { localTurns: Boolean(options.localTurns) },
      models: await options.accounts.models(options.identity),
    });
  }
  if (url.pathname.startsWith("/v1/local-turns")) {
    if (!options.localTurns) return json(response, 404, { error: "not_found" });
    const body = await readJson(
      request,
      url.pathname.endsWith("/reply") ? 12_000_000 : MAX_BODY_BYTES,
    );
    const owner = origin + ":" + token;
    if (url.pathname === "/v1/local-turns")
      return json(response, 202, options.localTurns.start(owner, body));
    const id = requiredString(body, "turnId");
    if (url.pathname === "/v1/local-turns/poll")
      return json(
        response,
        200,
        options.localTurns.poll(owner, id, body.offset as number),
      );
    if (url.pathname === "/v1/local-turns/reply")
      return json(
        response,
        200,
        options.localTurns.reply(
          owner,
          id,
          requiredString(body, "taskId"),
          body.value,
          body.error,
        ),
      );
    if (url.pathname === "/v1/local-turns/cancel")
      return json(response, 200, options.localTurns.cancel(owner, id));
    return json(response, 404, { error: "not_found" });
  }
  if (url.pathname === "/v1/jobs/native") {
    const body = (await readJson(request)) as unknown as LocalNativeJob;
    const job = validateLocalNativeJob(body, origin, options.identity);
    options.runNativeJob(job, body.capability);
    return json(response, 202, { status: "accepted", jobId: job.jobId });
  }
  return json(response, 404, { error: "not_found" });
}

function validateLocalNativeJob(
  input: LocalNativeJob,
  productOrigin: string,
  identity: string,
): NativeJob {
  if (
    !input ||
    !/^[0-9a-f-]{36}$/i.test(input.jobId) ||
    !/^[0-9a-f-]{36}$/i.test(input.sessionId) ||
    !/^[0-9a-f-]{36}$/i.test(input.turnId) ||
    input.mode !== "native" ||
    !input.storageNamespace ||
    !input.baseGraphObject ||
    !input.requestText ||
    input.requestText.length > 2_000 ||
    !["read_only", "selection", "slides", "document"].includes(
      input.permissionMode,
    ) ||
    typeof input.capability !== "string" ||
    input.capability.length < 64 ||
    input.capability.length > 2_048
  )
    throw new Error("invalid_local_native_job");
  const callback = exactProductJobUrl(
    input.callbackUrl,
    productOrigin,
    input.jobId,
    "callback",
  );
  const tools = exactProductJobUrl(
    input.toolUrl,
    productOrigin,
    input.jobId,
    "tools",
  );
  return {
    jobId: input.jobId,
    callbackUrl: callback,
    toolUrl: tools,
    mode: "native",
    email: identity,
    storageNamespace: input.storageNamespace,
    baseGraphObject: input.baseGraphObject,
    sessionId: input.sessionId,
    turnId: input.turnId,
    requestText: input.requestText,
    ...localConversationHistory(input.conversationHistory),
    activeGoal: normalizeActiveGoal(input.activeGoal, input.sessionId),
    permissionMode: input.permissionMode,
    ...(input.modelSettings ? { modelSettings: input.modelSettings } : {}),
  };
}

function localConversationHistory(
  input: unknown,
): Pick<NativeJob, "conversationHistory"> {
  if (input === undefined) return {};
  if (!Array.isArray(input) || input.length > 12)
    throw new Error("invalid_local_native_history");
  let characters = 0;
  const conversationHistory = input.map((value) => {
    const turn = value as Record<string, unknown> | null;
    if (
      !turn ||
      typeof turn.request !== "string" ||
      turn.request.length < 1 ||
      turn.request.length > 2_000 ||
      (turn.response !== null && typeof turn.response !== "string") ||
      (typeof turn.response === "string" && turn.response.length > 8_000) ||
      !["completed", "failed", "cancelled"].includes(String(turn.status))
    )
      throw new Error("invalid_local_native_history");
    characters += turn.request.length + (turn.response?.length ?? 0);
    if (characters > 24_000) throw new Error("invalid_local_native_history");
    return {
      request: turn.request,
      response: turn.response as string | null,
      status: turn.status as "completed" | "failed" | "cancelled",
    };
  });
  return { conversationHistory };
}

function exactProductJobUrl(
  value: string,
  origin: string,
  jobId: string,
  endpoint: "callback" | "tools",
): string {
  const url = new URL(value);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== `/api/native/jobs/${jobId}/${endpoint}`
  )
    throw new Error("invalid_local_native_job_url");
  return url.href;
}

function approvalPage(
  response: ServerResponse,
  approval: {
    id: string;
    origin: string;
    intent: "codex" | "claude";
    confirmationSecret: string;
    expiresAt: number;
  },
  connectorOrigin: string,
): void {
  const expires = new Date(approval.expiresAt).toLocaleTimeString("ko-KR");
  const action = `/pair/${encodeURIComponent(approval.id)}/confirm`;
  html(
    response,
    200,
    `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spellbook AI 연결 승인</title></head><body><main><div class="mark">S</div><p class="eyebrow">SPELLBOOK LOCAL CONNECTOR</p><h1>이 사이트에 AI 사용을 허용할까요?</h1><p class="copy"><strong>${escapeHtml(approval.origin)}</strong>에서 이 컴퓨터의 Spellbook AI 연결 앱을 사용하려고 합니다.</p><ul><li>연결된 Codex·Claude Code 구독에 접근할 수 있습니다.</li><li>문서에서 허용한 범위만 읽고 수정합니다.</li><li>구독 로그인 정보는 Spellbook 서버에 보관하지 않습니다.</li><li>연결은 ${escapeHtml(expires)}에 자동 만료됩니다.</li></ul><form method="post" action="${action}"><input type="hidden" name="confirmationSecret" value="${escapeHtml(approval.confirmationSecret)}"><button type="submit">연결 허용</button></form><p class="cancel">허용하지 않으려면 이 창을 닫으세요.</p></main></body></html>`,
    connectorOrigin,
    style(),
  );
}

function pairedPage(
  response: ServerResponse,
  session: {
    token: string;
    origin: string;
    challenge: string;
    expiresAt: number;
  },
  connectorOrigin: string,
  authUrl: string | null,
  loginStartFailed: boolean,
  intent: "codex" | "claude",
): void {
  const nonce = randomBytes(18).toString("base64url");
  const payload = JSON.stringify({
    type: "spellbook.local-connector.paired",
    token: session.token,
    challenge: session.challenge,
    expiresAt: session.expiresAt,
  }).replaceAll("<", "\\u003c");
  const targetOrigin = JSON.stringify(session.origin).replaceAll(
    "<",
    "\\u003c",
  );
  const next = authUrl
    ? `window.location.replace(${JSON.stringify(authUrl).replaceAll("<", "\\u003c")})`
    : loginStartFailed
      ? `document.getElementById('status').textContent=${JSON.stringify(intent === "claude" ? "Claude Code 로그인을 시작하지 못했습니다. 이 컴퓨터의 Claude Code 설치와 로그인을 확인해 주세요." : "OpenAI 로그인 화면을 열지 못했습니다. Spellbook에서 다시 시도해 주세요.")}`
      : "window.close()";
  html(
    response,
    200,
    `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spellbook AI 연결 완료</title></head><body><main><div class="mark done">✓</div><p class="eyebrow">로컬 연결 완료</p><h1>${authUrl ? "OpenAI 로그인을 계속합니다" : "Spellbook으로 돌아갑니다"}</h1><p class="copy" id="status">${authUrl ? "잠시 후 OpenAI 로그인 화면으로 이동합니다." : "이 창은 자동으로 닫힙니다."}</p></main><script nonce="${nonce}">const target=${targetOrigin};if(window.opener){window.opener.postMessage(${payload},target);${next}}</script></body></html>`,
    connectorOrigin,
    style(),
    nonce,
  );
}

function safeAuthUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid_browser_login_url");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("invalid_browser_login_url");
  return url.href;
}

function style(): string {
  return "html{color-scheme:light;font-family:Inter,system-ui,sans-serif;background:#f5f6f8;color:#17191d}body{margin:0;min-height:100vh;display:grid;place-items:center}main{width:min(440px,calc(100vw - 48px));background:#fff;border:1px solid #e2e5e9;border-radius:20px;padding:36px;box-shadow:0 24px 70px #1118271a}.mark{width:44px;height:44px;display:grid;place-items:center;border-radius:12px;background:#17191d;color:#fff;font-weight:750}.mark.done{background:#16825d}.eyebrow{margin:20px 0 8px;color:#676d76;font-size:12px;font-weight:700;letter-spacing:.08em}h1{font-size:25px;line-height:1.3;margin:0 0 14px}.copy{line-height:1.6;color:#4f5661}ul{padding-left:20px;color:#4f5661;line-height:1.75}button{width:100%;margin-top:18px;border:0;border-radius:10px;padding:13px 16px;background:#17191d;color:#fff;font:inherit;font-weight:700;cursor:pointer}.cancel{text-align:center;font-size:13px;color:#858b94;margin:16px 0 0}";
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

function assertHost(request: IncomingMessage, connectorOrigin: string): void {
  const expected = new URL(connectorOrigin).host;
  if (request.headers.host !== expected)
    throw new Error("invalid_connector_host");
}

function requiredOrigin(request: IncomingMessage): string {
  const value = request.headers.origin;
  if (!value || Array.isArray(value))
    throw new Error("connector_origin_required");
  return value;
}

function requireOrigin(request: IncomingMessage, expected: string): void {
  if (requiredOrigin(request) !== expected)
    throw new Error("connector_origin_not_allowed");
}

function requireLocalConfirmation(
  request: IncomingMessage,
  expected: string,
): void {
  const origin = request.headers.origin;
  if (origin === expected) return;
  // Chromium may serialize a loopback form navigation as an opaque origin
  // after the public opener has received Local Network Access permission.
  // Accept that browser shape only for a same-origin top-level navigation;
  // assertHost() and the single-use confirmation secret remain mandatory.
  if (
    (origin === "null" || origin === undefined) &&
    request.headers["sec-fetch-site"] === "same-origin" &&
    request.headers["sec-fetch-mode"] === "navigate" &&
    request.headers["sec-fetch-dest"] === "document"
  )
    return;
  throw new Error("connector_origin_not_allowed");
}

function bearerToken(request: IncomingMessage): string {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ") || value.length <= 7)
    throw new Error("connector_session_required");
  return value.slice(7);
}

function setCors(response: ServerResponse, origin: string): void {
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "Origin");
  response.setHeader("cache-control", "no-store");
}

async function readJson(
  request: IncomingMessage,
  maxBytes = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const raw = await readBody(request, maxBytes);
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new Error("content_type_required");
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("invalid_json");
  }
}

async function readForm(
  request: IncomingMessage,
): Promise<Record<string, string>> {
  if (
    !request.headers["content-type"]?.startsWith(
      "application/x-www-form-urlencoded",
    )
  )
    throw new Error("content_type_required");
  return Object.fromEntries(new URLSearchParams(await readBody(request)));
}

async function readBody(
  request: IncomingMessage,
  maxBytes = MAX_BODY_BYTES,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw new Error("request_too_large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function requiredString(
  value: Record<string, unknown> | Record<string, string>,
  key: string,
): string {
  if (typeof value[key] !== "string" || !value[key])
    throw new Error(`${key}_required`);
  return value[key];
}

function errorStatus(message: string): number {
  if (/not_found$/.test(message)) return 404;
  if (/origin|host|session|confirmation/.test(message)) return 403;
  if (message === "method_not_allowed") return 405;
  return 400;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(body));
}

function html(
  response: ServerResponse,
  status: number,
  body: string,
  connectorOrigin: string,
  css: string,
  scriptNonce?: string,
): void {
  if (response.headersSent) return;
  const styleNonce = randomBytes(18).toString("base64url");
  const withStyle = body.replace(
    "</head>",
    `<style nonce="${styleNonce}">${css}</style></head>`,
  );
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; style-src 'nonce-${styleNonce}'; script-src 'nonce-${scriptNonce ?? "none"}'; form-action ${connectorOrigin}; base-uri 'none'; frame-ancestors 'none'`,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end(withStyle);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
