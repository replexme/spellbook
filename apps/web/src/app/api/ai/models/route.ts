import { requireSession, routeError } from "@/lib/http";
import { callAiAccount } from "@/lib/workers";
import { getAccountProviders } from "@/lib/provider-keys";
import {
  anthropicModels,
  geminiModels,
  openAiModels,
  openRouterModels,
  type AvailableModel,
} from "@/lib/ai-models";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    let workerModels: AvailableModel[] = [];
    try {
      const res = (await callAiAccount("/internal/models", session.email)) as {
        models?: AvailableModel[];
      };
      if (Array.isArray(res?.models)) workerModels = res.models;
    } catch {}

    const customProviders = await getAccountProviders(session.accountId);
    const hasOpenAiKey = customProviders.some(
      (p) => p.provider === "openai_api",
    );
    const hasAnthropicKey = customProviders.some(
      (p) => p.provider === "anthropic_api",
    );
    const hasGeminiKey = customProviders.some(
      (p) => p.provider === "gemini_api",
    );
    const hasOpenRouterKey = customProviders.some(
      (p) => p.provider === "openrouter_api",
    );

    const models: AvailableModel[] = [...workerModels];

    if (hasGeminiKey && !models.some((m) => m.provider === "gemini_api")) {
      models.push(...geminiModels());
    }
    if (hasOpenAiKey && !models.some((m) => m.provider === "openai_api")) {
      models.push(...openAiModels());
    }
    if (hasAnthropicKey && !models.some((m) => m.provider === "anthropic_api")) {
      models.push(...anthropicModels());
    }
    if (hasOpenRouterKey && !models.some((m) => m.provider === "openrouter_api")) {
      models.push(...openRouterModels());
    }

    return Response.json(
      { models },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return routeError(error);
  }
}
