import { recoverStaleDocumentJobs, uploadDocument } from "@/lib/orchestration";
import { listLibrary } from "@/lib/document-library";
import { requireSession, routeError } from "@/lib/http";
import { recordUsageEvent } from "@/lib/usage-events";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    await recoverStaleDocumentJobs({ accountId: session.accountId });
    return Response.json({
      documents: await listLibrary(session),
    });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File))
      return Response.json({ error: "file_required" }, { status: 400 });
    const document = await uploadDocument(session, file);
    await recordUsageEvent(session.accountId, {
      type: "upload",
      documentId: document.id,
    });
    return Response.json(document, { status: 201 });
  } catch (error) {
    return routeError(error);
  }
}
