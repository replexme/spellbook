import { db } from "./db";
import { HttpError } from "./http";

/*
 * Page reads relayed for AI requests that run in the person's browser. A
 * read is allowed only for a request that is running right now (checked
 * by the caller with the request's capability), at most a few per request
 * and a bounded number per account per hour, so the relay cannot be used
 * as a general proxy.
 */
export const WEB_PAGE_READS_PER_REQUEST = 5;
export const WEB_PAGE_READS_PER_ACCOUNT_HOUR = 60;

export async function claimWebPageRead(
  jobId: string,
  accountId: string,
): Promise<void> {
  await db().begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtext(${`spellbook-web-page:${accountId}`}))`;
    const [used] = await sql`
      select coalesce(sum(j.web_page_reads),0)::int as reads
      from spellbook_jobs j
      join spellbook_native_turns t on t.job_id=j.id
      where t.account_id=${accountId}
        and j.created_at > now() - interval '1 hour'
    `;
    if (Number(used?.reads ?? 0) >= WEB_PAGE_READS_PER_ACCOUNT_HOUR)
      throw new HttpError(429, "web_page_rate_limited");
    const [claimed] = await sql`
      update spellbook_jobs set web_page_reads=web_page_reads+1, updated_at=now()
      where id=${jobId} and web_page_reads < ${WEB_PAGE_READS_PER_REQUEST}
      returning id
    `;
    if (!claimed) throw new HttpError(429, "web_page_request_limit");
  });
}
