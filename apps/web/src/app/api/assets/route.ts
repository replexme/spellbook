import { getObject } from "@/lib/storage";
import { requireSession, routeError } from "@/lib/http";

export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    const objectName = new URL(request.url).searchParams.get("object") ?? "";
    const accountKey = Buffer.from(session.accountId).toString("base64url");
    if (!objectName.startsWith(`accounts/${accountKey}/documents/`)) {
      return Response.json({ error: "asset_not_found" }, { status: 404 });
    }
    const data = await getObject(objectName);
    const contentType = objectName.endsWith(".png")
      ? "image/png"
      : objectName.endsWith(".json")
        ? "application/json"
        : "application/octet-stream";
    // A version's rendered files never change once written, so the browser
    // keeps them instead of asking again.
    const immutable = /\/versions\/[0-9a-f-]{36}\//i.test(objectName);
    return new Response(new Uint8Array(data), {
      headers: {
        "content-type": contentType,
        "cache-control": immutable
          ? "private, max-age=31536000, immutable"
          : "private, max-age=60",
      },
    });
  } catch (error) {
    return routeError(error);
  }
}
