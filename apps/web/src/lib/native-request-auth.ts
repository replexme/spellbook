import { db, ensureSchema } from "./db";
import { sessionFromRequest } from "./auth";
import { HttpError } from "./http";
import type { Session } from "./models";
import { verifyCapabilityToken } from "./capability-token";

// Opening a document requires the central SSO session. Once opened, every
// editor request carries a signed, document-scoped capability so long-running
// edits do not fail merely because the broader login cookie expires.
export async function requireNativeRequestSession(
  request: Request,
  documentId: string,
): Promise<Session> {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  if (!authorization) {
    const session = await sessionFromRequest(request);
    if (session) return session;
    throw new HttpError(401, "login_required");
  }

  const match = authorization.match(/^Bearer\s+(\S+)$/i);
  if (!match) throw new HttpError(401, "invalid_native_capability");
  let claims;
  try {
    claims = verifyCapabilityToken(match[1], documentId);
  } catch {
    throw new HttpError(401, "invalid_native_capability");
  }

  await ensureSchema();
  const [native] = await db()`
    select s.account_email
    from spellbook_native_sessions s
    join spellbook_documents d on d.id=s.document_id and d.account_id=s.account_id
    where s.id=${claims.sessionId} and s.document_id=${documentId}
      and s.account_id=${claims.accountId}
      and s.status in ('active','validating','failed') and s.expires_at > now()
  `;
  if (!native?.account_email)
    throw new HttpError(401, "invalid_native_capability");
  return {
    accountId: claims.accountId,
    email: String(native.account_email).toLowerCase(),
    admin: true,
    token: match[1],
  };
}
