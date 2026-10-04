import { browserDocumentSource } from "@/lib/browser-session";
import { requireSession, routeError } from "@/lib/http";

/** Where the editor reads its file: a storage link, or null for .../contents. */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    return Response.json(
      await browserDocumentSource(
        await requireSession(request),
        (await context.params).id,
      ),
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return routeError(error);
  }
}
