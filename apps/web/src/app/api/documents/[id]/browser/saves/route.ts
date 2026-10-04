import { startBrowserSave } from "@/lib/browser-session";
import { requireSession, routeError } from "@/lib/http";

/** A link to write a save straight to storage (direct: false when none). */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    return Response.json(
      await startBrowserSave(
        await requireSession(request),
        (await context.params).id,
        request,
      ),
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return routeError(error);
  }
}
