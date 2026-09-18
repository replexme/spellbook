import { routeError } from "@/lib/http";
import { requireNativeRequestSession } from "@/lib/native-request-auth";
import { markNativeUndo } from "@/lib/native-runtime";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { turnId?: unknown };
    return Response.json(
      await markNativeUndo(await requireNativeRequestSession(request, id), id, body.turnId),
    );
  } catch (error) {
    return routeError(error);
  }
}
