import { startDirectUpload } from "@/lib/orchestration";
import { requireSession, routeError } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Starts an upload the browser sends straight to storage, when it can. */
export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    return Response.json(await startDirectUpload(session, body), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return routeError(error);
  }
}
