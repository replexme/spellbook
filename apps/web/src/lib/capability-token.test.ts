import { afterEach, describe, expect, it, vi } from "vitest";
import { signCapabilityToken, verifyCapabilityToken } from "./capability-token";

afterEach(() => vi.unstubAllEnvs());
describe("document-scoped capability token", () => {
  it("round-trips an unexpired document session", () => {
    vi.stubEnv(
      "SPELLBOOK_WOPI_SECRET",
      "test-capability-secret-at-least-32-bytes",
    );
    const claims = {
      version: 1 as const,
      sessionId: "00000000-0000-4000-8000-000000000001",
      documentId: "00000000-0000-4000-8000-000000000002",
      accountId: "account-1",
      expiresAt: Date.now() + 60_000,
    };
    expect(
      verifyCapabilityToken(signCapabilityToken(claims), claims.documentId),
    ).toEqual(claims);
  });

  it("rejects tampering, the wrong document and expiry", () => {
    vi.stubEnv(
      "SPELLBOOK_WOPI_SECRET",
      "test-capability-secret-at-least-32-bytes",
    );
    const base = {
      version: 1 as const,
      sessionId: "00000000-0000-4000-8000-000000000001",
      documentId: "00000000-0000-4000-8000-000000000002",
      accountId: "account-1",
      expiresAt: Date.now() + 60_000,
    };
    const token = signCapabilityToken(base);
    expect(() => verifyCapabilityToken(`${token}x`, base.documentId)).toThrow();
    expect(() => verifyCapabilityToken(token, crypto.randomUUID())).toThrow();
    expect(() =>
      verifyCapabilityToken(
        signCapabilityToken({ ...base, expiresAt: Date.now() - 1 }),
        base.documentId,
      ),
    ).toThrow();
  });
});
