import { completeDirectUpload } from "@/lib/orchestration";
import { requireSession, routeError } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Records a file the browser stored directly as a new document. */
export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    const body = (await request.json().catch(() => ({}))) as {
      token?: unknown;
    };
    return Response.json(await completeDirectUpload(session, body.token), {
      status: 201,
    });
  } catch (error) {
    return routeError(error);
  }
}
