import { routeError } from "@/lib/http";
import {
  WopiLockConflict,
  wopiGetFile,
  wopiPutFile,
} from "@/lib/native-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    return new Response(
      new Uint8Array(await wopiGetFile(request, (await context.params).id)),
      {
        headers: {
          "content-type":
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          "cache-control": "private, no-store",
        },
      },
    );
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const result = await wopiPutFile(request, (await context.params).id);
    return Response.json(
      {
        LastModifiedTime: new Date().toISOString(),
        Unchanged: result.unchanged,
      },
      { headers: { "x-wopi-itemversion": result.version } },
    );
  } catch (error) {
    if (error instanceof WopiLockConflict)
      return new Response(null, {
        status: 409,
        headers: { "x-wopi-lock": error.lock },
      });
    if (
      error instanceof Error &&
      error.message === "native_ai_change_review_pending"
    ) {
      return Response.json({
        LastModifiedTime: new Date().toISOString(),
        Unchanged: true,
      });
    }
    return routeError(error);
  }
}
