import { HttpError } from "./http";
import { signClaims, verifiedClaims } from "./signed-claims";

/*
 * A Claude sign-in started in one AI worker instance waits there for the
 * code Claude's page shows. The page gets a short-lived reference carrying
 * that instance's routing cookie and hands it back with the code.
 */

const DOMAIN = "spellbook-claude-login-v1";
const LIFETIME_MS = 10 * 60_000;

interface ClaudeLoginClaims {
  version: 1;
  accountId: string;
  cookie: string;
  expiresAt: number;
}

export function claudeLoginReference(accountId: string, cookie: string) {
  return signClaims(DOMAIN, {
    version: 1,
    accountId,
    cookie,
    expiresAt: Date.now() + LIFETIME_MS,
  } satisfies ClaudeLoginClaims);
}

/** The routing cookie of the instance holding this account's sign-in. */
export function claudeLoginCookie(reference: unknown, accountId: string) {
  const claims =
    typeof reference === "string"
      ? (verifiedClaims(DOMAIN, reference) as ClaudeLoginClaims | null)
      : null;
  if (
    !claims ||
    claims.version !== 1 ||
    claims.accountId !== accountId ||
    typeof claims.cookie !== "string" ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.expiresAt <= Date.now()
  )
    throw new HttpError(400, "claude_login_expired");
  return claims.cookie;
}
