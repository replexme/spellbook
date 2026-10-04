import { retryDocumentProcessing } from "@/lib/orchestration";
import { requireSession, routeError } from "@/lib/http";

/** Checks an imported file again after a check that may pass on retry. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    return Response.json(
      await retryDocumentProcessing(
        await requireSession(request),
        (await context.params).id,
      ),
      { status: 202 },
    );
  } catch (error) {
    return routeError(error);
  }
}
