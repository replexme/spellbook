import { requireSession, routeError } from "@/lib/http";
import { callAiAccount } from "@/lib/workers";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    let rawStatus: any = null;
    try {
      rawStatus = (await callAiAccount(
        "/internal/account/status",
        session,
      )) as any;
    } catch {
      rawStatus = { account: null, rateLimits: null };
    }

    // API keys and the choice between a key and the subscription live in
    // the browser, stored per account under keyScope.
    const activeProvider = rawStatus?.account?.account ? "codex" : "none";

    const rateLimits = rawStatus?.rateLimits;
    const isRateLimited =
      rateLimits?.ordinaryUsageAllowed === false ||
      rateLimits?.rateLimits?.rateLimitReachedType === "rate_limit_reached" ||
      rateLimits?.rateLimitUpsell?.banner_type === "pro_rate_limit_reached";
    const resetAt = rateLimits?.rateLimitUpsell?.reset_at ?? null;

    return Response.json(
      {
        ...rawStatus,
        activeProvider,
        rateLimitInfo: {
          isRateLimited,
          resetAt,
          title:
            rateLimits?.rateLimitUpsell?.title ??
            (isRateLimited ? "Codex 사용량 한도 도달" : null),
          description: rateLimits?.rateLimitUpsell?.description ?? null,
        },
        keyScope: session.accountId,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return routeError(error);
  }
}
