import { requireSession, routeError } from "@/lib/http";
import { callAiAccount } from "@/lib/workers";
import { getAccountProviders } from "@/lib/provider-keys";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    let rawStatus: any = null;
    try {
      rawStatus = (await callAiAccount(
        "/internal/account/status",
        session.email,
      )) as any;
    } catch {
      rawStatus = { account: null, rateLimits: null };
    }

    const customProviders = await getAccountProviders(session.accountId);
    const activeCustom = customProviders.find((p) => p.isActive);
    const codexConnected = Boolean(rawStatus?.account?.account);

    let activeProvider = "none";
    if (activeCustom) {
      activeProvider = activeCustom.provider;
    } else if (codexConnected) {
      activeProvider = "codex";
    }

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
        customProviders,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return routeError(error);
  }
}
