import { signClaims, verifiedClaims } from "./signed-claims";

const TOKEN_DOMAIN = "spellbook-native-connector-v1";

export interface NativeConnectorClaims {
  version: 1;
  jobId: string;
  sessionId: string;
  accountId: string;
  expiresAt: number;
}

export function signNativeConnectorToken(
  claims: NativeConnectorClaims,
): string {
  return signClaims(TOKEN_DOMAIN, claims);
}

export function verifyNativeConnectorToken(
  token: string,
  jobId: string,
): NativeConnectorClaims {
  const claims = verifiedClaims(TOKEN_DOMAIN, token) as NativeConnectorClaims;
  if (
    !claims ||
    claims.version !== 1 ||
    claims.jobId !== jobId ||
    !/^[0-9a-f-]{36}$/i.test(claims.jobId) ||
    !/^[0-9a-f-]{36}$/i.test(claims.sessionId) ||
    typeof claims.accountId !== "string" ||
    !claims.accountId ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.expiresAt <= Date.now()
  )
    throw new Error("invalid_native_connector_capability");
  return claims;
}

export function bearerNativeConnectorToken(request: Request): string {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const match = authorization.match(/^Bearer\s+(\S+)$/i);
  if (!match || match[1].length > 2_048)
    throw new Error("invalid_native_connector_capability");
  return match[1];
}
