import { randomUUID } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type RequestListener,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLocalConnectorHandler } from "./local-connector-server.js";
import { LocalNativeTurns } from "./local-native-turns.js";
import { LocalPairingAuthority } from "./local-pairing.js";

const productOrigin = "https://spellbook.replex.me";
const challenge = "browser_pairing_challenge_1234567890_abcd";
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

async function harness(localTurns?: LocalNativeTurns) {
  let handler: RequestListener | undefined;
  const server = createServer((request, response) => {
    if (!handler) throw new Error("test_handler_not_ready");
    handler(request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const connectorOrigin = `http://127.0.0.1:${address.port}`;
  const authority = new LocalPairingAuthority(Buffer.alloc(32, 9), [
    productOrigin,
  ]);
  const models = vi.fn().mockResolvedValue([{ model: "gpt-5" }]);
  const accounts = {
    status: vi.fn().mockResolvedValue({ account: null }),
    startBrowserLogin: vi
      .fn()
      .mockResolvedValue({ type: "chatgpt", authUrl: "https://auth.example" }),
    startClaudeBrowserLogin: vi.fn().mockResolvedValue({ status: "started" }),
    startLogin: vi.fn().mockResolvedValue({ type: "chatgptDeviceCode" }),
    logout: vi.fn().mockResolvedValue(undefined),
    models,
  };
  const runNativeJob = vi.fn();
  handler = createLocalConnectorHandler({
    authority,
    accounts,
    connectorOrigin,
    identity: "local@spellbook",
    runNativeJob,
    localTurns,
  });
  return { accounts, authority, connectorOrigin, models, runNativeJob };
}

async function pair(connectorOrigin: string) {
  const begin = await fetch(`${connectorOrigin}/v1/pairings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: productOrigin,
    },
    body: JSON.stringify({ challenge }),
  });
  expect(begin.status).toBe(201);
  expect(begin.headers.get("access-control-allow-origin")).toBe(productOrigin);
  const started = (await begin.json()) as {
    pairing: { id: string };
    approvalUrl: string;
  };
  expect(started.approvalUrl).not.toContain("token");

  const approval = await fetch(started.approvalUrl);
  const approvalHtml = await approval.text();
  const confirmationSecret = approvalHtml.match(
    /name="confirmationSecret" value="([A-Za-z0-9_-]+)"/,
  )?.[1];
  expect(confirmationSecret).toBeTruthy();

  const rejected = await fetch(`${started.approvalUrl}/confirm`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://evil.example",
    },
    body: new URLSearchParams({ confirmationSecret: confirmationSecret! }),
  });
  expect(rejected.status).toBe(403);

  const confirmed = await fetch(`${started.approvalUrl}/confirm`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: connectorOrigin,
    },
    body: new URLSearchParams({ confirmationSecret: confirmationSecret! }),
  });
  const confirmedHtml = await confirmed.text();
  const payloadSource = confirmedHtml.match(
    /window\.opener\.postMessage\((\{.+?\}),target\)/,
  )?.[1];
  expect(payloadSource).toBeTruthy();
  const payload = JSON.parse(payloadSource!) as {
    token: string;
    challenge: string;
  };
  expect(payload.challenge).toBe(challenge);
  expect(confirmedHtml).not.toContain(`${connectorOrigin}?`);
  return payload.token;
}

async function pendingConfirmation(
  connectorOrigin: string,
  intent: "codex" | "claude" = "codex",
) {
  const begin = await fetch(`${connectorOrigin}/v1/pairings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: productOrigin,
    },
    body: JSON.stringify({ challenge, intent }),
  });
  expect(begin.status).toBe(201);
  const started = (await begin.json()) as { approvalUrl: string };
  const approval = await fetch(started.approvalUrl);
  const confirmationSecret = (await approval.text()).match(
    /name="confirmationSecret" value="([A-Za-z0-9_-]+)"/,
  )?.[1];
  expect(confirmationSecret).toBeTruthy();
  return { ...started, confirmationSecret: confirmationSecret! };
}

function postConfirmation(
  url: string,
  confirmationSecret: string,
  fetchSite: "same-origin" | "cross-site",
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const body = new URLSearchParams({ confirmationSecret }).toString();
    const request = httpRequest(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(body),
          origin: "null",
          "sec-fetch-site": fetchSite,
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

describe("local connector HTTP boundary", () => {
  it("pairs Claude Code and starts only its official device login", async () => {
    const h = await harness();
    const started = await pendingConfirmation(h.connectorOrigin, "claude");
    const approval = await fetch(started.approvalUrl);
    const approvalHtml = await approval.text();
    expect(approvalHtml).toContain("Codex·Claude Code 구독");
    expect(approvalHtml).toContain("Spellbook 서버에 보관하지 않습니다");
    const confirmed = await postConfirmation(
      `${started.approvalUrl}/confirm`,
      started.confirmationSecret,
      "same-origin",
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toContain("spellbook.local-connector.paired");
    expect(confirmed.body).not.toContain("auth.example");
    expect(h.accounts.startBrowserLogin).not.toHaveBeenCalled();
    expect(h.accounts.startClaudeBrowserLogin).toHaveBeenCalledOnce();
    expect(h.accounts.status).toHaveBeenCalledOnce();
  });

  it("accepts Chromium's opaque loopback form origin only with same-origin navigation metadata", async () => {
    const h = await harness();
    const started = await pendingConfirmation(h.connectorOrigin);
    const rejected = await postConfirmation(
      `${started.approvalUrl}/confirm`,
      started.confirmationSecret,
      "cross-site",
    );
    expect(rejected.status).toBe(403);

    const retry = await pendingConfirmation(h.connectorOrigin);
    const confirmed = await postConfirmation(
      `${retry.approvalUrl}/confirm`,
      retry.confirmationSecret,
      "same-origin",
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toContain("spellbook.local-connector.paired");
  });

  it("answers an allowed private-network preflight without opening a session", async () => {
    const h = await harness();
    const response = await fetch(`${h.connectorOrigin}/v1/account/status`, {
      method: "OPTIONS",
      headers: {
        origin: productOrigin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type",
        "access-control-request-private-network": "true",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      productOrigin,
    );
    expect(response.headers.get("access-control-allow-private-network")).toBe(
      "true",
    );
  });

  it("requires explicit local approval and binds the capability to the product origin", async () => {
    const h = await harness();
    const token = await pair(h.connectorOrigin);
    expect(h.authority.verify(productOrigin, token)).toMatchObject({
      origin: productOrigin,
    });

    const status = await fetch(`${h.connectorOrigin}/v1/account/status`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: productOrigin },
    });
    expect(status.status).toBe(200);
    expect(h.accounts.status).toHaveBeenCalledWith("local@spellbook");

    const wrongOrigin = await fetch(`${h.connectorOrigin}/v1/account/status`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        origin: "https://evil.example",
      },
    });
    expect(wrongOrigin.status).toBe(403);
    expect(wrongOrigin.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("uses browser login by default, exposes models, and revokes on logout", async () => {
    const h = await harness();
    const token = await pair(h.connectorOrigin);
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      origin: productOrigin,
    };
    const login = await fetch(`${h.connectorOrigin}/v1/account/login`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(login.status).toBe(200);
    expect(h.accounts.startBrowserLogin).toHaveBeenCalledWith(
      "local@spellbook",
    );
    expect(h.accounts.startLogin).not.toHaveBeenCalled();

    const models = await fetch(`${h.connectorOrigin}/v1/models`, {
      method: "POST",
      headers,
    });
    expect(models.status).toBe(200);
    expect(h.models).toHaveBeenCalledOnce();

    const logout = await fetch(`${h.connectorOrigin}/v1/account/logout`, {
      method: "POST",
      headers,
    });
    expect(logout.status).toBe(200);
    const revoked = await fetch(`${h.connectorOrigin}/v1/account/status`, {
      method: "POST",
      headers,
    });
    expect(revoked.status).toBe(403);
  });

  it("can unpair this browser without logging out the local AI accounts", async () => {
    const h = await harness();
    const token = await pair(h.connectorOrigin);
    const headers = { authorization: `Bearer ${token}`, origin: productOrigin };
    const unpair = await fetch(`${h.connectorOrigin}/v1/pairings/revoke`, {
      method: "POST",
      headers,
    });
    expect(unpair.status).toBe(200);
    expect(h.accounts.logout).not.toHaveBeenCalled();
    const status = await fetch(`${h.connectorOrigin}/v1/account/status`, {
      method: "POST",
      headers,
    });
    expect(status.status).toBe(403);
  });

  it("requires the paired browser capability to retry Claude Code login", async () => {
    const h = await harness();
    const token = await pair(h.connectorOrigin);
    const path = `${h.connectorOrigin}/v1/claude/login`;
    const denied = await fetch(path, {
      method: "POST",
      headers: { origin: productOrigin },
    });
    expect(denied.status).toBe(403);
    const accepted = await fetch(path, {
      method: "POST",
      headers: { origin: productOrigin, authorization: `Bearer ${token}` },
    });
    expect(accepted.status).toBe(200);
    expect(h.accounts.startClaudeBrowserLogin).toHaveBeenCalledOnce();
  });

  it("accepts one product-scoped native job without trusting its account identity", async () => {
    const h = await harness();
    const token = await pair(h.connectorOrigin);
    const jobId = randomUUID();
    const job = {
      jobId,
      callbackUrl: `${productOrigin}/api/native/jobs/${jobId}/callback`,
      toolUrl: `${productOrigin}/api/native/jobs/${jobId}/tools`,
      mode: "native",
      email: "attacker@example.test",
      storageNamespace: "local",
      baseGraphObject: `accounts/test/documents/${randomUUID()}/versions/${randomUUID()}/render/element-graph.json`,
      sessionId: randomUUID(),
      turnId: randomUUID(),
      requestText: "선택한 제목을 고쳐줘",
      conversationHistory: [
        {
          request: "제목을 봐줘",
          response: "현재 제목을 확인했습니다.",
          status: "completed",
        },
      ],
      permissionMode: "selection",
      capability: "c".repeat(64),
    };
    const response = await fetch(`${h.connectorOrigin}/v1/jobs/native`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        origin: productOrigin,
      },
      body: JSON.stringify(job),
    });
    expect(response.status).toBe(202);
    expect(h.runNativeJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId,
        email: "local@spellbook",
        toolUrl: `${productOrigin}/api/native/jobs/${jobId}/tools`,
        conversationHistory: [
          {
            request: "제목을 봐줘",
            response: "현재 제목을 확인했습니다.",
            status: "completed",
          },
        ],
      }),
      job.capability,
    );
  });

  it("rejects a native job that could send its capability to another origin", async () => {
    const h = await harness();
    const token = await pair(h.connectorOrigin);
    const jobId = randomUUID();
    const response = await fetch(`${h.connectorOrigin}/v1/jobs/native`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        origin: productOrigin,
      },
      body: JSON.stringify({
        jobId,
        callbackUrl: `${productOrigin}/api/native/jobs/${jobId}/callback`,
        toolUrl: `https://metadata.google.internal/api/native/jobs/${jobId}/tools`,
        mode: "native",
        storageNamespace: "local",
        baseGraphObject: `accounts/test/documents/${randomUUID()}/versions/${randomUUID()}/render/element-graph.json`,
        sessionId: randomUUID(),
        turnId: randomUUID(),
        requestText: "수정",
        permissionMode: "document",
        capability: "c".repeat(64),
      }),
    });
    expect(response.status).toBe(400);
    expect(h.runNativeJob).not.toHaveBeenCalled();
  });
});

it("local browser turns require paired origin and token for every document operation", async () => {
  const turns = new LocalNativeTurns(async () => {
    throw Error("not_used");
  });
  try {
    const { connectorOrigin } = await harness(turns),
      tokenA = await pair(connectorOrigin),
      tokenB = await pair(connectorOrigin);
    const post = (
      path: string,
      body: unknown,
      token = tokenA,
      origin = productOrigin,
    ) =>
      fetch(connectorOrigin + path, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          ...(token ? { authorization: "Bearer " + token } : {}),
        },
        body: JSON.stringify(body),
      });
    const body = { requestText: "inspect", permissionMode: "read_only" };
    expect((await post("/v1/local-turns", body, "")).status).toBe(403);
    expect(
      (await post("/v1/local-turns", body, tokenA, "https://evil.example"))
        .status,
    ).toBe(403);
    const created = await post("/v1/local-turns", body);
    expect(created.status).toBe(202);
    const { turnId } = (await created.json()) as { turnId: string };
    expect(
      (await post("/v1/local-turns/poll", { turnId, offset: 0 }, tokenB))
        .status,
    ).toBe(404);
    const poll = await post("/v1/local-turns/poll", { turnId, offset: 0 });
    expect(poll.status).toBe(200);
    const value = (await poll.json()) as {
      tasks: Array<{ id: string; request: { operation: string } }>;
    };
    expect(value.tasks[0].request.operation).toBe("observe");
    expect(
      (
        await post(
          "/v1/local-turns/reply",
          { turnId, taskId: value.tasks[0].id, value: {} },
          tokenB,
        )
      ).status,
    ).toBe(404);
    expect(
      (await post("/v1/local-turns/cancel", { turnId }, tokenB)).status,
    ).toBe(404);
    expect((await post("/v1/local-turns/cancel", { turnId })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const done = (await (
      await post("/v1/local-turns/poll", { turnId, offset: 0 })
    ).json()) as { done: boolean; tasks: unknown[] };
    expect(done.done).toBe(true);
    expect(done.tasks).toEqual([]);
  } finally {
    turns.dispose();
  }
});
