import { completeBrowserSave } from "@/lib/browser-session";
import { requireSession, routeError } from "@/lib/http";

/** Checks the file the browser stored and saves it as a new version. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const saved = await completeBrowserSave(
      await requireSession(request),
      (await context.params).id,
      request,
    );
    return Response.json(saved, {
      headers: { "cache-control": "private, no-store", etag: saved.revision },
    });
  } catch (error) {
    return routeError(error);
  }
}
