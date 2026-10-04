import { db } from "../../../../../../lib/db";
import { authorizeNativeConnectorJob } from "../../../../../../lib/native-connector-auth";
import { HttpError, routeError } from "../../../../../../lib/http";
import { fetchPublicPage, pageText } from "../../../../../../lib/safe-web-fetch";
import { claimWebPageRead } from "../../../../../../lib/web-page-reads";

export const dynamic = "force-dynamic";

/**
 * Reads a public web page for an AI request running in the person's browser
 * (most sites refuse direct browser reads). Only a running request may use
 * it, with that request's capability, within the per-request and per-hour
 * read limits.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await context.params;
    const job = await authorizeNativeConnectorJob(request, jobId);
    if (job.payload?.execution !== "browser")
      throw new HttpError(403, "web_page_browser_request_only");
    const body = (await request.json().catch(() => null)) as {
      url?: unknown;
    } | null;
    if (typeof body?.url !== "string" || !body.url.trim())
      throw new HttpError(400, "web_fetch_invalid_url");
    const [turn] =
      await db()`select account_id from spellbook_native_turns where job_id=${job.id}`;
    if (!turn) throw new HttpError(409, "native_connector_job_inactive");
    await claimWebPageRead(job.id, String(turn.account_id));
    try {
      const text = pageText(
        await fetchPublicPage(body.url.trim(), request.signal),
      );
      return Response.json(
        { text },
        { headers: { "cache-control": "no-store" } },
      );
    } catch (error) {
      return Response.json(
        {
          error: error instanceof Error ? error.message : "web_fetch_failed",
        },
        { status: 422 },
      );
    }
  } catch (error) {
    return routeError(error);
  }
}
