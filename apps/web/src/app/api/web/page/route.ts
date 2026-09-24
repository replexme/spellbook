import { HttpError, requireSession, routeError } from "@/lib/http";
import { fetchPublicPage, pageText } from "@/lib/safe-web-fetch";

export const dynamic = "force-dynamic";

/** Reads a public web page for an AI request running in the user's browser. */
export async function POST(request: Request) {
  try {
    await requireSession(request);
    const body = (await request.json().catch(() => null)) as {
      url?: unknown;
    } | null;
    if (typeof body?.url !== "string" || !body.url.trim())
      throw new HttpError(400, "web_fetch_invalid_url");
    const text = pageText(
      await fetchPublicPage(body.url.trim(), request.signal),
    );
    return Response.json(
      { text },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof HttpError) return routeError(error);
    return Response.json(
      { error: error instanceof Error ? error.message : "web_fetch_failed" },
      { status: 422 },
    );
  }
}
