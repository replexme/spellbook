import { requireSession, routeError } from "@/lib/http";
import { callAiAccount } from "@/lib/workers";
import { getAccountProviders } from "@/lib/provider-keys";
import type { AvailableModel } from "@/lib/ai-models";

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

    const models: AvailableModel[] = [...workerModels];

    if (hasOpenAiKey && !models.some((m) => m.provider === "openai_api")) {
      models.push(
        {
          provider: "openai_api",
          model: "gpt-4o",
          displayName: "GPT-4o (OpenAI API)",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "기본" },
          ],
          isDefault: models.length === 0,
        },
        {
          provider: "openai_api",
          model: "gpt-4o-mini",
          displayName: "GPT-4o mini (OpenAI API)",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "기본" },
          ],
          isDefault: false,
        },
        {
          provider: "openai_api",
          model: "o3-mini",
          displayName: "o3-mini (OpenAI API)",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "빠르게" },
            { reasoningEffort: "medium", description: "보통" },
            { reasoningEffort: "high", description: "꼼꼼하게" },
          ],
          isDefault: false,
        },
      );
    }

    if (hasAnthropicKey && !models.some((m) => m.provider === "anthropic_api")) {
      models.push(
        {
          provider: "anthropic_api",
          model: "claude-3-7-sonnet-20250219",
          displayName: "Claude 3.7 Sonnet (Anthropic API)",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "빠르게" },
            { reasoningEffort: "medium", description: "보통" },
            { reasoningEffort: "high", description: "꼼꼼하게" },
          ],
          isDefault: models.length === 0,
        },
        {
          provider: "anthropic_api",
          model: "claude-3-5-sonnet-20241022",
          displayName: "Claude 3.5 Sonnet (Anthropic API)",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "기본" },
          ],
          isDefault: false,
        },
      );
    }

    return Response.json(
      { models },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return routeError(error);
  }
}
