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
    const allowed = [
      "openai_api",
      "anthropic_api",
      "gemini_api",
      "openrouter_api",
      "custom_api",
    ];
    if (!allowed.includes(body.provider ?? "")) {
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
