import { routeError } from "@/lib/http";
import { requireNativeRequestSession } from "@/lib/native-request-auth";
import { pollNativeSession } from "@/lib/native-runtime";
import { recoverStaleDocumentJobs } from "@/lib/orchestration";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const after = Number(new URL(request.url).searchParams.get("after") ?? 0);
    const { id } = await context.params;
    const session = await requireNativeRequestSession(request, id);
    await recoverStaleDocumentJobs({
      accountId: session.accountId,
      documentId: id,
    });
    return Response.json(await pollNativeSession(session, id, after), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return routeError(error);
  }
}
