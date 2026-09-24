import { db, ensureSchema } from "./db";
import { HttpError } from "./http";
import {
  bearerNativeConnectorToken,
  verifyNativeConnectorToken,
} from "./native-connector-token";

export async function authorizeNativeConnectorJob(
  request: Request,
  jobId: string,
) {
  let claims;
  try {
    claims = verifyNativeConnectorToken(
      bearerNativeConnectorToken(request),
      jobId,
    );
  } catch {
    throw new HttpError(401, "invalid_native_connector_capability");
  }
  await ensureSchema();
  const [job] = await db()`
    select j.*
    from spellbook_jobs j
    join spellbook_native_turns t on t.job_id=j.id
    join spellbook_native_sessions s on s.id=t.session_id
    where j.id=${claims.jobId}
      and j.job_type='native_turn'
      and j.status in ('queued','running')
      and j.payload->>'execution' in ('local','browser')
      and t.session_id=${claims.sessionId}
      and t.account_id=${claims.accountId}
      and t.status in ('queued','running')
      and s.status in ('active','validating')
      and s.expires_at > now()
  `;
  if (!job) throw new HttpError(409, "native_connector_job_inactive");
  return job;
}
