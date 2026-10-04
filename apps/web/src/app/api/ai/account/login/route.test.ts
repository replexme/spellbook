import { beforeEach, describe, expect, it, vi } from "vitest";

const workers = vi.hoisted(() => ({
  streamAiAccount: vi.fn(),
  callAiAccount: vi.fn(),
}));
vi.mock("../../../../../lib/workers", async (original) => ({
  ...(await original<typeof import("../../../../../lib/workers")>()),
  ...workers,
}));
vi.mock("../../../../../lib/auth", () => ({
  sessionFromRequest: async () => ({
    accountId: "account-a",
    email: "a@example.test",
  }),
}));

import { AiAccountError } from "../../../../../lib/workers";
import { readLoginStream } from "../../../../../lib/ai-login-stream";
import { POST as startSignIn } from "./route";
import { POST as completeSignIn } from "./complete/route";

const request = (body: unknown) =>
  new Request("https://spellbook.test/api/ai/account/login", {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  workers.streamAiAccount.mockReset();
  workers.callAiAccount.mockReset();
});

describe("subscription sign-in routes", () => {
  it("streams the worker's sign-in to the page, ending it with the page", async () => {
    workers.streamAiAccount.mockResolvedValue(
      new Response(
        '{"type":"started","loginId":"l1","verificationUrl":"https://claude.com/cai/oauth/authorize?x"}\n{"type":"finished","connected":true}\n',
      ),
    );
    const incoming = request({ provider: "claude_code" });
    const response = await startSignIn(incoming);
    expect(response.headers.get("content-type")).toMatch(/ndjson/);
    const started = vi.fn();
    await expect(readLoginStream(response, started)).resolves.toMatchObject({
      connected: true,
    });
    expect(started).toHaveBeenCalledWith(
      expect.objectContaining({ loginId: "l1" }),
    );
    expect(workers.streamAiAccount).toHaveBeenCalledWith(
      "/internal/account/login/stream",
      expect.objectContaining({ accountId: "account-a" }),
      { body: { provider: "claude_code" }, signal: incoming.signal },
    );
  });

  it("falls back to the status watch with a connector that cannot stream", async () => {
    workers.streamAiAccount.mockRejectedValue(new AiAccountError(404, {}));
    workers.callAiAccount.mockResolvedValue({
      loginId: "l2",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
    });
    const started = vi.fn();
    const finished = await readLoginStream(
      await startSignIn(request({})),
      started,
    );
    expect(started).toHaveBeenCalledWith(
      expect.objectContaining({ userCode: "ABCD-EFGH" }),
    );
    expect(finished).toMatchObject({ connected: false, pending: true });
  });

  it("reports a sign-in that cannot start without worker details", async () => {
    workers.streamAiAccount.mockRejectedValue(
      new AiAccountError(400, { error: "claude_login_unavailable: spawn ENOENT" }),
    );
    const response = await startSignIn(request({ provider: "claude_code" }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "claude_login_unavailable" });
  });

  it("hands the code to whichever worker instance runs the sign-in", async () => {
    workers.callAiAccount.mockResolvedValue({ connected: true });
    const loginId = "0f0e0d0c-0b0a-4908-8706-050403020100";
    const response = await completeSignIn(
      request({ loginId, code: "abc12345#state678" }),
    );
    expect(await response.json()).toEqual({ connected: true });
    expect(workers.callAiAccount).toHaveBeenCalledWith(
      "/internal/account/login/complete",
      expect.objectContaining({ accountId: "account-a" }),
      expect.objectContaining({
        body: { provider: "claude_code", code: "abc12345#state678", loginId },
      }),
    );
    workers.callAiAccount.mockRejectedValue(
      new AiAccountError(400, { error: "claude_login_code_invalid" }),
    );
    const refused = await completeSignIn(
      request({ loginId, code: "abc12345#state678" }),
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "claude_login_code_invalid" });
    const noLogin = await completeSignIn(request({ loginId: "x", code: "abc12345#s" }));
    expect(await noLogin.json()).toEqual({ error: "claude_login_expired" });
  });
});
