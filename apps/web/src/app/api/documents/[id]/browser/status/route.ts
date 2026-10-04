import { requireSession, routeError } from "@/lib/http";
import { pollNativeSession } from "@/lib/native-runtime";
import { recoverStaleDocumentJobs } from "@/lib/orchestration";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireSession(request);
    const { id } = await context.params;
    await recoverStaleDocumentJobs({
      accountId: session.accountId,
      documentId: id,
    });
    const status = await pollNativeSession(session, id, 0);
    return Response.json(
      { session: status.session },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return routeError(error);
  }
}
