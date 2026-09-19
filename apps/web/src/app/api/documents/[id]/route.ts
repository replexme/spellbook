import { documentDetail } from "@/lib/orchestration";
import { deleteDocument, renameDocument } from "@/lib/document-library";
import { requireSession, routeError } from "@/lib/http";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const detail = await documentDetail(
      await requireSession(request),
      id,
      request.headers.get("if-none-match") ?? undefined,
    );
    const headers = {
      etag: detail.revision,
      "cache-control": "private, no-cache",
    };
    return "notModified" in detail
      ? new Response(null, { status: 304, headers })
      : Response.json(detail, { headers });
  } catch (error) {
    return routeError(error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      fileName?: unknown;
    };
    return Response.json(
      await renameDocument(await requireSession(request), id, body.fileName),
    );
  } catch (error) {
    return routeError(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    return Response.json(
      await deleteDocument(await requireSession(request), id),
    );
  } catch (error) {
    return routeError(error);
  }
}
