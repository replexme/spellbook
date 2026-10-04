import { completeDirectUpload } from "@/lib/orchestration";
import { requireSession, routeError } from "@/lib/http";
import { recordUsageEvent } from "@/lib/usage-events";

export const dynamic = "force-dynamic";

/** Records a file the browser stored directly as a new document. */
export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    const body = (await request.json().catch(() => ({}))) as {
      token?: unknown;
    };
    const document = await completeDirectUpload(session, body.token);
    await recordUsageEvent(session.accountId, {
      type: "upload",
      documentId: document.id,
    });
    return Response.json(document, { status: 201 });
  } catch (error) {
    return routeError(error);
  }
}
