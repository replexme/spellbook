import { documentSummary } from "@/lib/document-library";
import { requireNativeRequestSession } from "@/lib/native-request-auth";
import { routeError } from "@/lib/http";
import { recoverStaleDocumentJobs } from "@/lib/orchestration";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const session = await requireNativeRequestSession(request, id);
    await recoverStaleDocumentJobs({
      accountId: session.accountId,
      documentId: id,
    });
    return Response.json(await documentSummary(session, id), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return routeError(error);
  }
}
