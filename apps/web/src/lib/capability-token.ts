import { createHmac, timingSafeEqual } from "node:crypto";

import { signingSecret } from "./signed-claims";

/**
 * A document-scoped capability: it lets one native session call the
 * document's editor API (sent as a Bearer token) after the broader login
 * cookie has expired. Format: base64url(JSON claims) "." base64url(HMAC).
 */
export interface CapabilityClaims {
  version: 1;
  sessionId: string;
  documentId: string;
  accountId: string;
  expiresAt: number;
}

export function signCapabilityToken(claims: CapabilityClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", signingSecret())
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyCapabilityToken(
  token: string,
  documentId: string,
): CapabilityClaims {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra)
    throw new Error("invalid_capability_token");
  const expected = createHmac("sha256", signingSecret())
    .update(payload)
    .digest();
  let given: Buffer;
  try {
    given = Buffer.from(signature, "base64url");
  } catch {
    throw new Error("invalid_capability_token");
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    throw new Error("invalid_capability_token");
  let claims: CapabilityClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid_capability_token");
  }
  if (
    claims.version !== 1 ||
    claims.documentId !== documentId ||
    !/^[0-9a-f-]{36}$/i.test(claims.sessionId) ||
    typeof claims.accountId !== "string" ||
    !claims.accountId ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.expiresAt <= Date.now()
  )
    throw new Error("invalid_capability_token");
  return claims;
}
