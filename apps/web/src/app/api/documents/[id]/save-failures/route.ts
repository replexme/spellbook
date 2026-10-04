import { requireBrowserOrigin } from "@/lib/browser-session";
import { db, ensureSchema } from "@/lib/db";
import { HttpError, requireSession, routeError } from "@/lib/http";
import { recordUsageEvent, usageReason } from "@/lib/usage-events";

export const dynamic = "force-dynamic";

/**
 * The editor page reports that a save failed in the browser (the editor
 * could not produce or hand over the file), which the server never sees
 * otherwise. Only the document id and a short stage code are kept.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    requireBrowserOrigin(request);
    const session = await requireSession(request);
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      stage?: unknown;
    };
    await ensureSchema();
    const [owned] = await db()`
      select 1 from spellbook_documents
      where id=${id}::uuid and account_id=${session.accountId}
    `.catch(() => []);
    if (!owned) throw new HttpError(404, "document_not_found");
    await recordUsageEvent(session.accountId, {
      type: "save_failed_client",
      documentId: id,
      stage: usageReason(body.stage),
    });
    return new Response(null, {
      status: 204,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return routeError(error);
  }
}
