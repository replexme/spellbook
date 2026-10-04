import { directDownloadUrl, downloadCurrent } from "@/lib/orchestration";
import { HttpError, requireSession, routeError } from "@/lib/http";
import { recordUsageEvent } from "@/lib/usage-events";

const PPTX =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  try {
    const source = new URL(request.url).searchParams.get("source") ?? "current";
    if (source !== "current" && source !== "original" && source !== "candidate")
      throw new HttpError(400, "invalid_download_source");
    const session = await requireSession(request);
    // Large files go straight from storage to the browser when it can.
    const direct = await directDownloadUrl(session, id, source, PPTX);
    if (direct) {
      await recordUsageEvent(session.accountId, {
        type: "download",
        documentId: id,
        source,
      });
      return new Response(null, {
        status: 302,
        headers: { location: direct, "cache-control": "private, no-store" },
      });
    }
    const file = await downloadCurrent(session, id, source);
    await recordUsageEvent(session.accountId, {
      type: "download",
      documentId: id,
      source,
    });
    return new Response(new Uint8Array(file.data), {
      headers: {
        "content-type": PPTX,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    const failed = routeError(error);
    // A download is usually a link the person clicked: show a Korean page,
    // not the JSON body meant for scripts.
    if (!acceptsPage(request)) return failed;
    const body = (await failed.json().catch(() => ({}))) as {
      error?: string;
      errorId?: string;
    };
    const target = new URLSearchParams({ document: id });
    if (body.error) target.set("reason", body.error);
    if (body.errorId) target.set("ref", body.errorId);
    return new Response(null, {
      status: 303,
      headers: {
        location: `/download-error?${target}`,
        "cache-control": "private, no-store",
      },
    });
  }
}

function acceptsPage(request: Request): boolean {
  return (
    request.headers.get("sec-fetch-mode") === "navigate" ||
    (request.headers.get("accept") ?? "").includes("text/html")
  );
}
