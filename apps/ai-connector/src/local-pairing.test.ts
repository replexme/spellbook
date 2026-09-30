import { describe, expect, it } from "vitest";

import { LocalPairingAuthority } from "./local-pairing.js";

const secret = Buffer.alloc(32, 7);
const challenge = "test_browser_challenge_1234567890_abcd";

describe("local connector pairing", () => {
  it("issues an origin-bound session only after one explicit confirmation", () => {
    let now = 1_000;
    const authority = new LocalPairingAuthority(
      secret,
      ["https://spellbook.replex.me"],
      () => now,
    );
    const pairing = authority.begin("https://spellbook.replex.me", challenge);
    expect(pairing).toMatchObject({
      origin: "https://spellbook.replex.me",
      challenge,
      intent: "codex",
      expiresAt: 121_000,
    });
    expect(pairing).not.toHaveProperty("confirmationSecret");
    const approval = authority.approval(pairing.id);
    expect(approval.confirmationSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(() => authority.confirm(pairing.id, "wrong")).toThrow(
      "invalid_pairing_confirmation",
    );

    const session = authority.confirm(pairing.id, approval.confirmationSecret);
    expect(session.challenge).toBe(challenge);
    expect(
      authority.verify("https://spellbook.replex.me", session.token),
    ).toMatchObject({ origin: "https://spellbook.replex.me" });
    expect(() =>
      authority.confirm(pairing.id, approval.confirmationSecret),
    ).toThrow("pairing_request_not_found");

    expect(() =>
      authority.verify("https://other.example", session.token),
    ).toThrow("connector_origin_not_allowed");
    authority.revoke("https://spellbook.replex.me", session.token);
    expect(() =>
      authority.verify("https://spellbook.replex.me", session.token),
    ).toThrow("invalid_connector_session");
    now += 1;
  });

  it("keeps the selected provider through local approval", () => {
    const authority = new LocalPairingAuthority(secret, [
      "https://spellbook.replex.me",
    ]);
    const pairing = authority.begin(
      "https://spellbook.replex.me",
      challenge,
      "claude",
    );
    const approval = authority.approval(pairing.id);
    expect(approval.intent).toBe("claude");
    expect(
      authority.confirm(pairing.id, approval.confirmationSecret).intent,
    ).toBe("claude");
  });

  it("rejects expired pairings and sessions", () => {
    let now = 5_000;
    const authority = new LocalPairingAuthority(
      secret,
      ["https://spellbook.replex.me"],
      () => now,
      100,
      200,
    );
    const expiredPairing = authority.begin(
      "https://spellbook.replex.me",
      challenge,
    );
    now += 101;
    expect(() => authority.approval(expiredPairing.id)).toThrow(
      "pairing_request_not_found",
    );

    const pairing = authority.begin("https://spellbook.replex.me", challenge);
    const approval = authority.approval(pairing.id);
    const session = authority.confirm(pairing.id, approval.confirmationSecret);
    now += 201;
    expect(() =>
      authority.verify("https://spellbook.replex.me", session.token),
    ).toThrow("invalid_connector_session");
  });

  it("allows exact local development origins but rejects unsafe origins and challenges", () => {
    const authority = new LocalPairingAuthority(secret, [
      "http://localhost:3000",
    ]);
    expect(authority.begin("http://localhost:3000", challenge).origin).toBe(
      "http://localhost:3000",
    );
    expect(() =>
      authority.begin("http://localhost:3000/path", challenge),
    ).toThrow("invalid_connector_origin");
    expect(
      () => new LocalPairingAuthority(secret, ["http://spellbook.example"]),
    ).toThrow("insecure_connector_origin");
    expect(() => authority.begin("http://localhost:3000", "short")).toThrow(
      "invalid_pairing_challenge",
    );
    expect(
      () =>
        new LocalPairingAuthority(Buffer.alloc(16), [
          "https://spellbook.replex.me",
        ]),
    ).toThrow("local_pairing_secret_too_short");
  });

  it("allows a secure origin after explicit approval when no operator allowlist is configured", () => {
    const authority = new LocalPairingAuthority(secret);
    const pairing = authority.begin("https://documents.example", challenge);
    const approval = authority.approval(pairing.id);
    const session = authority.confirm(pairing.id, approval.confirmationSecret);
    expect(
      authority.verify("https://documents.example", session.token),
    ).toMatchObject({ origin: "https://documents.example" });
    expect(() =>
      authority.begin("http://documents.example", challenge),
    ).toThrow("insecure_connector_origin");
  });
});
