import { nativeSessionState } from "@/lib/native-runtime";
import { requireNativeRequestSession } from "@/lib/native-request-auth";
import { routeError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    return Response.json(
      await nativeSessionState(await requireNativeRequestSession(request, id), id),
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return routeError(error);
  }
}
