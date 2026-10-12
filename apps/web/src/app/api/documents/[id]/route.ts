import { deleteDocument, renameDocument } from "@/lib/document-library";
import { requireSession, routeError } from "@/lib/http";

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
