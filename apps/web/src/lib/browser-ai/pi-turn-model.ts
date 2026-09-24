import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createModels, type Api, type Model } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { BrowserKeyProvider } from "./key-store";
import type { TurnModel } from "./native-turn";

/*
 * Runs the model for one request straight from this browser to the AI
 * provider with the user's own key. The key never reaches Spellbook's
 * servers; every provider here accepts browser (CORS) requests.
 */

const PI_PROVIDER: Record<BrowserKeyProvider, string> = {
  gemini_api: "google",
  openai_api: "openai",
  anthropic_api: "anthropic",
  openrouter_api: "openrouter",
};

const FALLBACK: Record<BrowserKeyProvider, { api: Api; baseUrl: string }> = {
  gemini_api: {
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  },
  openai_api: { api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
  anthropic_api: {
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
  },
  openrouter_api: {
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
  },
};

const THINKING = new Set(["low", "medium", "high"]);

function catalog() {
  const models = createModels();
  models.setProvider(googleProvider());
  models.setProvider(openaiProvider());
  models.setProvider(anthropicProvider());
  models.setProvider(openrouterProvider());
  return models;
}

/** The provider's catalog entry, or a plain one for a model it does not list yet. */
function modelFor(
  models: ReturnType<typeof catalog>,
  provider: BrowserKeyProvider,
  modelId: string,
): Model<Api> {
  const known = models.getModel(PI_PROVIDER[provider], modelId);
  if (known) return known;
  return {
    id: modelId,
    name: modelId,
    ...FALLBACK[provider],
    provider: PI_PROVIDER[provider],
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  } as Model<Api>;
}

export function browserTurnModel(
  provider: BrowserKeyProvider,
  apiKey: string,
): TurnModel {
  const models = catalog();
  return {
    async run(input) {
      const modelId = input.modelSettings?.model;
      if (!modelId) throw new Error("model_not_selected");
      const effort = input.modelSettings?.effort ?? "medium";
      const tools: AgentTool[] = input.tools.map((tool) => ({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as never,
        execute: async (_callId, params, signal) => {
          const output = await input.onTool(
            tool.name,
            params,
            signal ?? input.signal,
          );
          return {
            content: [
              { type: "text" as const, text: output.text },
              ...(output.images ?? []).map((data) => ({
                type: "image" as const,
                data,
                mimeType: "image/png",
              })),
            ],
            details: { ok: output.ok },
          };
        },
      }));
      const agent = new Agent({
        initialState: {
          systemPrompt: input.instructions,
          model: modelFor(models, provider, modelId),
          thinkingLevel: THINKING.has(effort) ? (effort as never) : "medium",
          tools,
        },
        streamFn: models.streamSimple.bind(models),
        getApiKey: () => apiKey,
        toolExecution: "sequential",
      });
      let streamed = "";
      const unsubscribe = agent.subscribe((event) => {
        if (event.type !== "message_update") return;
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta") {
          streamed += update.delta;
          input.onText(update.delta);
        } else if (update.type === "thinking_delta")
          input.onThinking?.(update.delta);
      });
      const abort = () => agent.abort();
      const deadline = setTimeout(abort, input.timeoutMs);
      input.signal.addEventListener("abort", abort, { once: true });
      try {
        if (input.signal.aborted) throw new Error("cancelled");
        await agent.prompt("프레젠테이션 작업을 시작해 주세요.");
      } finally {
        clearTimeout(deadline);
        input.signal.removeEventListener("abort", abort);
        unsubscribe();
      }
      if (input.signal.aborted) throw new Error("cancelled");
      const last = agent.state.messages.at(-1) as
        | {
            role?: string;
            stopReason?: string;
            errorMessage?: string;
            content?: Array<{ type: string; text?: string }>;
          }
        | undefined;
      if (last?.role === "assistant" && last.stopReason === "error")
        throw new Error(last.errorMessage || "ai_provider_error");
      if (last?.role === "assistant" && last.stopReason === "aborted")
        throw new Error("ai_turn_timed_out");
      const finalText =
        last?.role === "assistant"
          ? (last.content ?? [])
              .filter((part) => part.type === "text" && part.text)
              .map((part) => part.text)
              .join("")
          : "";
      return finalText.trim() ? finalText : streamed;
    },
  };
}
