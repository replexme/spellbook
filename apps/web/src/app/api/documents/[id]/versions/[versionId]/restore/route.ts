import { restoreVersion } from "@/lib/document-history";
import { requireNativeRequestSession } from "@/lib/native-request-auth";
import { routeError } from "@/lib/http";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; versionId: string }> },
) {
  try {
    const { id, versionId } = await context.params;
    return Response.json(
      await restoreVersion(await requireNativeRequestSession(request, id), id, versionId),
    );
  } catch (error) {
    return routeError(error);
  }
}
