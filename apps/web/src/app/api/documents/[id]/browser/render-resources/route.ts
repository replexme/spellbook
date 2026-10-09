import { browserRenderResources } from "@/lib/browser-render-resources";
import { requireSession, routeError } from "@/lib/http";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const result = await browserRenderResources(
      await requireSession(request),
      (await context.params).id,
      request.headers.get("if-match") ?? "",
      new URL(request.url).searchParams.get("sha256"),
    );
    const headers = {
      "cache-control": "private, no-store",
      etag: result.revision,
    };
    if ("asset" in result && result.asset)
      return new Response(new Uint8Array(result.asset.bytes), {
        headers: {
          ...headers,
          "content-type": result.asset.contentType,
          "x-content-sha256": result.asset.sha256,
        },
      });
    return Response.json(result, { headers });
  } catch (error) {
    return routeError(error);
  }
}
