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
    } catch (caught) {
      console.error("Failed to fetch worker models:", caught);
    }

    const customProviders = await getAccountProviders(session.accountId);
    const models: AvailableModel[] = [...workerModels];

    for (const p of customProviders) {
      if (Array.isArray(p.modelsCache) && p.modelsCache.length > 0) {
        for (const m of p.modelsCache) {
          if (!models.some((ex) => ex.model === m.model && ex.provider === m.provider)) {
            models.push(m);
          }
        }
      } else {
        if (p.provider === "gemini_api" && !models.some((m) => m.provider === "gemini_api")) {
          models.push(...geminiModels());
        }
        if (p.provider === "openai_api" && !models.some((m) => m.provider === "openai_api")) {
          models.push(...openAiModels());
        }
        if (p.provider === "anthropic_api" && !models.some((m) => m.provider === "anthropic_api")) {
          models.push(...anthropicModels());
        }
        if (p.provider === "openrouter_api" && !models.some((m) => m.provider === "openrouter_api")) {
          models.push(...openRouterModels());
        }
      }
    }

    return Response.json(
      { models },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return routeError(error);
  }
}
