import { HttpError, requireSession, routeError } from "@/lib/http";
import { callAiAccount } from "@/lib/workers";
import { claudeLoginCookie } from "@/lib/claude-login";
import { aiConnectorConfig } from "@/lib/ai-connector-config";

/** Hands the code Claude's sign-in page showed to the waiting sign-in. */
export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    if (aiConnectorConfig().mode === "local")
      throw new HttpError(410, "local_connector_required");
    const body = (await request.json().catch(() => ({}))) as {
      code?: unknown;
      loginReference?: unknown;
    };
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!code || code.length > 512)
      throw new HttpError(400, "claude_login_code_invalid");
    return Response.json(
      await callAiAccount("/internal/account/login/complete", session, {
        body: { provider: "claude_code", code },
        cookie: claudeLoginCookie(body.loginReference, session.accountId),
        timeoutMs: 90_000,
      }),
    );
  } catch (error) {
    return routeError(error);
  }
}
