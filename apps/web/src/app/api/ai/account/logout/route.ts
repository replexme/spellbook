import { requireSession, routeError } from "@/lib/http";
import { callAiAccount } from "@/lib/workers";

export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    const body = (await request.json().catch(() => ({}))) as {
      provider?: unknown;
    };
    return Response.json(
      await callAiAccount("/internal/account/logout", session, {
        body:
          body.provider === "claude_code" ? { provider: "claude_code" } : {},
      }),
    );
  } catch (error) {
    return routeError(error);
  }
}
