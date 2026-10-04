import { HttpError, requireSession, routeError } from "../../../../../lib/http";
import {
  AiAccountError,
  callAiAccount,
  streamAiAccount,
} from "../../../../../lib/workers";
import { aiConnectorConfig } from "../../../../../lib/ai-connector-config";
import { loginStreamLine, LOGIN_STREAM_HEADERS } from "../../../../../lib/ai-login-stream";

export const dynamic = "force-dynamic";

/**
 * Starts a subscription sign-in and streams it to the page as lines of
 * JSON: `started` (the sign-in page, and for ChatGPT the code), `waiting`,
 * then `finished`. The sign-in runs inside this one request on the AI
 * worker, so completing it never depends on reaching a particular worker
 * instance. Closing the page ends the sign-in.
 */
export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    if (aiConnectorConfig().mode === "local")
      throw new HttpError(410, "local_connector_required");
    const body = (await request.json().catch(() => ({}))) as {
      provider?: unknown;
    };
    const claude = body.provider === "claude_code";
    let upstream: Response;
    try {
      upstream = await streamAiAccount("/internal/account/login/stream", session, {
        body: claude ? { provider: "claude_code" } : {},
        signal: request.signal,
      });
    } catch (error) {
      // A connector without streamed sign-in (an older self-hosted one)
      // starts ChatGPT's device sign-in; the page then waits on the status.
      if (!claude && error instanceof AiAccountError && error.status === 404) {
        const started = (await callAiAccount(
          "/internal/account/login/start",
          session,
        )) as Record<string, unknown>;
        return new Response(
          loginStreamLine({ type: "started", ...started }) +
            loginStreamLine({ type: "finished", connected: false, pending: true }),
          { headers: LOGIN_STREAM_HEADERS },
        );
      }
      throw new HttpError(
        502,
        claude ? "claude_login_unavailable" : "chatgpt_login_unavailable",
      );
    }
    return new Response(upstream.body, { headers: LOGIN_STREAM_HEADERS });
  } catch (error) {
    return routeError(error);
  }
}
