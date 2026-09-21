import { requireSession, routeError } from "@/lib/http";
import { saveProviderKey, type ApiKeyProvider } from "@/lib/provider-keys";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    const body = (await request.json()) as {
      provider?: string;
      apiKey?: string;
      active?: boolean;
    };
    if (
      body.provider !== "openai_api" &&
      body.provider !== "anthropic_api"
    ) {
      return Response.json({ error: "invalid_provider" }, { status: 400 });
    }
    if (typeof body.apiKey !== "string" || !body.apiKey.trim()) {
      return Response.json({ error: "api_key_required" }, { status: 400 });
    }
    await saveProviderKey(
      session.accountId,
      body.provider as ApiKeyProvider,
      body.apiKey,
      body.active !== false,
    );
    return Response.json({ status: "ok", provider: body.provider });
  } catch (error) {
    return routeError(error);
  }
}
