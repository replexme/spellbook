import { createBlankDocument } from "@/lib/orchestration";
import { requireSession, routeError } from "@/lib/http";

export const runtime = "nodejs";

/** Creates a new, empty document: `{ "formatId": "pptx" | "idml" }`. */
export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    const body = (await request.json().catch(() => ({}))) as { formatId?: unknown };
    const document = await createBlankDocument(session, body.formatId);
    return Response.json(document, { status: 201 });
  } catch (error) {
    return routeError(error);
  }
}
