import { requireBrowserOrigin } from "@/lib/browser-session";
import { db, ensureSchema } from "@/lib/db";
import { HttpError, requireSession, routeError } from "@/lib/http";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    requireBrowserOrigin(request);
    const session = await requireSession(request);
    const { id } = await context.params;
    const parsed = await request.json().catch(() => ({}));
    const body =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    if (
      typeof body.errorReference !== "string" ||
      !/^[0-9A-F]{8}$/.test(body.errorReference) ||
      typeof body.code !== "string" ||
      !/^[a-z][a-z0-9_]{1,79}$/.test(body.code) ||
      typeof body.occurredAt !== "string" ||
      body.occurredAt.length > 40 ||
      !Number.isFinite(Date.parse(body.occurredAt))
    )
      throw new HttpError(400, "invalid_editor_error");
    await ensureSchema();
    const [owned] =
      await db()`select 1 from spellbook_documents where id=${id}::uuid and account_id=${session.accountId}`.catch(
        () => [],
      );
    if (!owned) throw new HttpError(404, "document_not_found");
    const payload = {
      errorReference: body.errorReference,
      code: body.code,
      occurredAt: new Date(body.occurredAt).toISOString(),
    };
    const [record] = await db()`
      insert into spellbook_events (document_id,event_type,payload)
      select ${id}::uuid,'editor_error',${db().json(payload)}
      where not exists (select 1 from spellbook_events where document_id=${id}::uuid and event_type='editor_error' and payload->>'errorReference'=${payload.errorReference})
        and (select count(*) from spellbook_events where document_id=${id}::uuid and event_type='editor_error' and created_at > now()-interval '1 hour') < 100
      returning id
    `;
    if (record)
      console.error(
        JSON.stringify({ event: "editor_error", documentId: id, ...payload }),
      );
    return new Response(null, {
      status: 204,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return routeError(error);
  }
}
