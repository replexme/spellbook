import { getBrowserDocument, saveBrowserDocument } from "@/lib/browser-session";
import { requireSession, routeError } from "@/lib/http";
import type { Session } from "@/lib/models";
import { recordUsageEvent } from "@/lib/usage-events";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const file = await getBrowserDocument(
      await requireSession(request),
      (await context.params).id,
    );
    return new Response(new Uint8Array(file.data), {
      headers: {
        "content-type":
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
        "cache-control": "private, no-store",
        etag: file.revision,
      },
    });
  } catch (error) {
    return routeError(error);
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  let session: Session | null = null;
  const documentId = (await context.params).id;
  try {
    session = await requireSession(request);
    const saved = await saveBrowserDocument(session, documentId, request);
    await recordUsageEvent(session.accountId, {
      type: "save_accepted",
      documentId,
      unchanged: saved.unchanged,
    });
    return Response.json(saved, {
      headers: {
        "cache-control": "private, no-store",
        etag: saved.revision,
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    // Edits made while an AI request runs are saved after it: not a failure.
    if (session && reason !== "native_ai_change_review_pending")
      await recordUsageEvent(session.accountId, {
        type: "save_rejected",
        documentId,
        reason,
      });
    return routeError(error);
  }
}
