import { HttpError, requireSession, routeError } from "../../../../../../lib/http";
import { AiAccountError, callAiAccount } from "../../../../../../lib/workers";
import { aiConnectorConfig } from "../../../../../../lib/ai-connector-config";

/**
 * Hands the code Claude's sign-in page showed to the sign-in waiting for it.
 * Any web or worker instance can take it: the worker that runs the sign-in
 * picks it up from the account's storage folder.
 */
export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    if (aiConnectorConfig().mode === "local")
      throw new HttpError(410, "local_connector_required");
    const body = (await request.json().catch(() => ({}))) as {
      code?: unknown;
      loginId?: unknown;
    };
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const loginId = typeof body.loginId === "string" ? body.loginId : "";
    if (!code || code.length > 512)
      throw new HttpError(400, "claude_login_code_invalid");
    if (!/^[0-9a-f-]{36}$/u.test(loginId))
      throw new HttpError(400, "claude_login_expired");
    try {
      return Response.json(
        await callAiAccount("/internal/account/login/complete", session, {
          body: { provider: "claude_code", code, loginId },
          timeoutMs: 100_000,
        }),
      );
    } catch (error) {
      if (
        error instanceof AiAccountError &&
        /^claude_login_[a-z_]+$/u.test(error.message)
      )
        throw new HttpError(400, error.message);
      throw error;
    }
  } catch (error) {
    return routeError(error);
  }
}
