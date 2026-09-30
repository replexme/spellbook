import { describe, expect, it, vi } from "vitest";

import {
  callLocalConnector,
  LOCAL_CONNECTOR_SESSION_KEY,
  localConnectorOrigin,
  pairLocalConnector,
  readLocalConnectorSession,
} from "./local-ai-connector";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe("local AI connector browser client", () => {
  it("uses only an explicit runtime connector configuration", () => {
    expect(localConnectorOrigin(undefined)).toBeNull();
    expect(localConnectorOrigin({ mode: "internal" })).toBeNull();
    expect(
      localConnectorOrigin({
        mode: "local",
        origin: "http://127.0.0.1:43127",
      }),
    ).toBe("http://127.0.0.1:43127");
  });

  it("accepts only a live session and clears malformed or expired state", () => {
    const state = storage();
    state.setItem(LOCAL_CONNECTOR_SESSION_KEY, "not-json");
    expect(readLocalConnectorSession(state, 100)).toBeNull();
    expect(state.getItem(LOCAL_CONNECTOR_SESSION_KEY)).toBeNull();
    state.setItem(
      LOCAL_CONNECTOR_SESSION_KEY,
      JSON.stringify({ token: "x".repeat(32), challenge: "c", expiresAt: 99 }),
    );
    expect(readLocalConnectorSession(state, 100)).toBeNull();
    state.setItem(
      LOCAL_CONNECTOR_SESSION_KEY,
      JSON.stringify({ token: "x".repeat(32), challenge: "c", expiresAt: 101 }),
    );
    expect(readLocalConnectorSession(state, 100)).toMatchObject({
      expiresAt: 101,
    });
  });

  it.each(["codex", "claude"] as const)(
    "opens the exact %s approval page and accepts only its matching challenge",
    async (intent) => {
      const connectorOrigin = "http://127.0.0.1:43127";
      const state = storage();
      let listener: ((event: MessageEvent) => void) | undefined;
      let requestedChallenge = "";
      const popup = {
        close: vi.fn(),
        location: {
          replace: vi.fn((url: string) => {
            queueMicrotask(() =>
              listener?.({
                origin: connectorOrigin,
                source: popup,
                data: {
                  type: "spellbook.local-connector.paired",
                  token: "t".repeat(64),
                  challenge: requestedChallenge,
                  expiresAt: 10_000,
                },
              } as unknown as MessageEvent),
            );
          }),
        },
      };
      const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        requestedChallenge = body.challenge;
        expect(body.intent).toBe(intent);
        return Response.json(
          {
            approvalUrl: `${connectorOrigin}/pair/12345678-abcd-abcd-abcd-123456789012`,
          },
          { status: 201 },
        );
      });
      const session = await pairLocalConnector(connectorOrigin, intent, {
        fetch: fetcher as typeof fetch,
        open: vi.fn(() => popup as unknown as Window),
        addMessageListener: (value) => {
          listener = value;
        },
        removeMessageListener: (value) => {
          if (listener === value) listener = undefined;
        },
        storage: state,
        randomBytes: () => new Uint8Array(32),
        setTimer: () => 1,
        clearTimer: vi.fn(),
        now: () => 1_000,
      });
      expect(session.challenge).toBe(requestedChallenge);
      expect(popup.location.replace).toHaveBeenCalledWith(
        `${connectorOrigin}/pair/12345678-abcd-abcd-abcd-123456789012`,
      );
      expect(readLocalConnectorSession(state, 1_000)).toEqual(session);
    },
  );

  it("does not leave a message listener or timer after the connector is unavailable", async () => {
    let listener: ((event: MessageEvent) => void) | undefined;
    const removeMessageListener = vi.fn();
    const clearTimer = vi.fn();
    const popup = { close: vi.fn() };
    await expect(
      pairLocalConnector("http://127.0.0.1:43127", "codex", {
        fetch: vi
          .fn()
          .mockResolvedValue(
            Response.json({ error: "offline" }, { status: 503 }),
          ) as typeof fetch,
        open: vi.fn(() => popup as unknown as Window),
        addMessageListener: (value) => {
          listener = value;
        },
        removeMessageListener,
        storage: storage(),
        randomBytes: () => new Uint8Array(32),
        setTimer: () => 1,
        clearTimer,
        now: () => 1_000,
      }),
    ).rejects.toThrow("local_connector_unavailable");
    expect(listener).toBeUndefined();
    expect(removeMessageListener).not.toHaveBeenCalled();
    expect(clearTimer).toHaveBeenCalledWith(0);
    expect(popup.close).toHaveBeenCalledOnce();
  });

  it("never sends the capability in the URL", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ account: null }));
    await callLocalConnector(
      "http://127.0.0.1:43127",
      "/v1/account/status",
      { token: "secret-capability", challenge: "c", expiresAt: 10_000 },
      undefined,
      fetcher,
    );
    const [url, init] = fetcher.mock.calls[0];
    expect(url).not.toContain("secret-capability");
    expect(init.headers.authorization).toBe("Bearer secret-capability");
  });
});
