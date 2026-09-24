import { directDownloadUrl, downloadCurrent } from "@/lib/orchestration";
import { HttpError, requireSession, routeError } from "@/lib/http";

const PPTX =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const source = new URL(request.url).searchParams.get("source") ?? "current";
    if (source !== "current" && source !== "original" && source !== "candidate")
      throw new HttpError(400, "invalid_download_source");
    const session = await requireSession(request);
    // Large files go straight from storage to the browser when it can.
    const direct = await directDownloadUrl(session, id, source, PPTX);
    if (direct)
      return new Response(null, {
        status: 302,
        headers: { location: direct, "cache-control": "private, no-store" },
      });
    const file = await downloadCurrent(session, id, source);
    return new Response(new Uint8Array(file.data), {
      headers: {
        "content-type": PPTX,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    return routeError(error);
  }
}
