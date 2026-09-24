import { requireSession, routeError } from "@/lib/http";
import { callAiAccount } from "@/lib/workers";
import { claudeLoginReference } from "@/lib/claude-login";

export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    const body = (await request.json().catch(() => ({}))) as {
      provider?: unknown;
    };
    if (body.provider !== "claude_code")
      return Response.json(
        await callAiAccount("/internal/account/login/start", session),
      );
    let cookie = "";
    const started = (await callAiAccount(
      "/internal/account/login/start",
      session,
      {
        body: { provider: "claude_code" },
        onCookie: (value) => (cookie = value),
        timeoutMs: 60_000,
      },
    )) as { verificationUrl?: string };
    return Response.json({
      verificationUrl: started.verificationUrl,
      loginReference: claudeLoginReference(session.accountId, cookie),
    });
  } catch (error) {
    return routeError(error);
  }
}
