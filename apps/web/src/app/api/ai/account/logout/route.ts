import { HttpError, requireSession, routeError } from "@/lib/http";
import { callAiAccount } from "@/lib/workers";
import { aiConnectorConfig } from "@/lib/ai-connector-config";

export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    if (aiConnectorConfig().mode === "local")
      throw new HttpError(410, "local_connector_required");
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
