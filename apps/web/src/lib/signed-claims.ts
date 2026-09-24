import { createHmac, timingSafeEqual } from "node:crypto";

/*
 * Short-lived claims handed to the browser and checked when they come back.
 * Each use has its own domain, so a token made for one purpose never
 * verifies for another.
 */

function secret(): string {
  const value = process.env.SPELLBOOK_WOPI_SECRET?.trim();
  if (!value) throw new Error("SPELLBOOK_WOPI_SECRET is required.");
  if (Buffer.byteLength(value) < 32)
    throw new Error("SPELLBOOK_WOPI_SECRET must be at least 32 bytes.");
  return value;
}

function signature(domain: string, payload: string): Buffer {
  return createHmac("sha256", secret())
    .update(domain)
    .update("\0")
    .update(payload)
    .digest();
}

export function signClaims(domain: string, claims: object): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${signature(domain, payload).toString("base64url")}`;
}

/** The signed claims, or null when the token is malformed or not ours. */
export function verifiedClaims(domain: string, token: string): unknown {
  const [payload, encodedSignature, extra] = token.split(".");
  if (!payload || !encodedSignature || extra) return null;
  const given = Buffer.from(encodedSignature, "base64url");
  const expected = signature(domain, payload);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
