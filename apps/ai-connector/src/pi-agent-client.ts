import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentTurnClient,
  AgentTurnOptions,
} from "./app-server-client.js";
import type {
  AccountReadResult,
  AvailableModel,
} from "./types.js";
import {
  openAiModels,
  anthropicModels,
  geminiModels,
  openRouterModels,
} from "./api-clients.js";

type ProviderId =
  | "openai_api"
  | "anthropic_api"
  | "gemini_api"
  | "openrouter_api"
  | "custom_api";

function mapToPiProvider(providerId: ProviderId): string {
  switch (providerId) {
    case "gemini_api":
      return "google";
    case "anthropic_api":
      return "anthropic";
    case "openai_api":
      return "openai";
    case "openrouter_api":
      return "openrouter";
    case "custom_api":
      return "openai";
  }
}

function defaultModelForProvider(providerId: ProviderId): string {
  switch (providerId) {
    case "gemini_api":
      return "gemini-3.8-flash";
    case "anthropic_api":
      return "claude-3-7-sonnet-20250219";
    case "openai_api":
      return "gpt-4o";
    case "openrouter_api":
      return "deepseek/deepseek-chat";
    case "custom_api":
      return "default";
  }
}

export class PiAgentClient implements AgentTurnClient {
  readonly supportsImageGeneration = false;

  constructor(
    private readonly apiKey: string,
    private readonly providerId: ProviderId,
    private readonly baseUrl?: string,
  ) {}

  async accountRead(): Promise<AccountReadResult> {
    const names: Record<ProviderId, string> = {
      gemini_api: "Google AI Studio",
      anthropic_api: "Anthropic API",
      openai_api: "OpenAI API",
      openrouter_api: "OpenRouter",
      custom_api: "Custom Endpoint",
    };
    return {
      account: {
        type: this.providerId,
        email: null,
        planType: names[this.providerId] || "API Key",
      },
      requiresOpenaiAuth: false,
    };
  }

  async models(): Promise<AvailableModel[]> {
    switch (this.providerId) {
      case "gemini_api":
        return geminiModels();
      case "anthropic_api":
        return anthropicModels();
      case "openai_api":
        return openAiModels();
      case "openrouter_api":
        return openRouterModels();
      case "custom_api":
        return [
          {
            provider: "custom_api",
            model: "default",
            displayName: "Custom Model (Configured Base URL)",
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
              { reasoningEffort: "medium", description: "기본" },
            ],
            isDefault: true,
          },
        ];
    }
  }

  async runStructuredTurn(
    input: Array<Record<string, unknown>>,
    _outputSchema: Record<string, unknown>,
    _timeoutMs = 300_000,
    options?: AgentTurnOptions,
  ): Promise<string> {
    const piProvider = mapToPiProvider(this.providerId);
    const modelId =
      options?.modelSettings?.model || defaultModelForProvider(this.providerId);

    if (piProvider === "google") {
      process.env.GEMINI_API_KEY = this.apiKey;
    } else if (piProvider === "anthropic") {
      process.env.ANTHROPIC_API_KEY = this.apiKey;
    } else if (piProvider === "openai") {
      process.env.OPENAI_API_KEY = this.apiKey;
    } else if (piProvider === "openrouter") {
      process.env.OPENROUTER_API_KEY = this.apiKey;
    }

    const modelRuntime = await ModelRuntime.create();
    await modelRuntime.setRuntimeApiKey(piProvider, this.apiKey);

    let model = modelRuntime.getModel(piProvider, modelId);
    if (!model) {
      const isGoogle = piProvider === "google";
      const isAnthropic = piProvider === "anthropic";
      model = {
        id: modelId,
        name: modelId,
        api: isGoogle
          ? "google-generative-ai"
          : isAnthropic
            ? "anthropic"
            : "openai",
        provider: piProvider,
        baseUrl:
          this.baseUrl?.replace(/\/+$/, "") ||
          (isGoogle
            ? "https://generativelanguage.googleapis.com/v1beta"
            : isAnthropic
              ? "https://api.anthropic.com"
              : this.providerId === "openrouter_api"
                ? "https://openrouter.ai/api/v1"
                : "https://api.openai.com/v1"),
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_048_576,
        maxTokens: 65_536,
        inputLimits: {
          maxRequestBytes: 20_971_520,
          images: { maxPerRequest: 3600 },
        },
      } as any;
    }

    const systemPrompt = input.find((item) => item.type === "text")?.text;

    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: `/tmp/pi-session-${Date.now()}`,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: typeof systemPrompt === "string" ? systemPrompt : undefined,
      extensionFactories: [
        (pi) => {
          if (options?.tools && options.tools.length > 0) {
            for (const tool of options.tools) {
              pi.registerTool({
                name: tool.name,
                label: tool.name,
                description: tool.description,
                parameters: tool.inputSchema as any,
                execute: async (
                  toolCallId,
                  params,
                  signal,
                ) => {
                  try {
                    const result = await options.onTool?.(
                      tool.name,
                      params as Record<string, unknown>,
                      toolCallId,
                      signal ?? new AbortController().signal,
                    );
                    const content: Array<{
                      type: string;
                      text?: string;
                      data?: string;
                      mimeType?: string;
                    }> = [];

                    if (result && typeof result === "object") {
                      const items = (result as any).contentItems;
                      if (Array.isArray(items)) {
                        for (const item of items) {
                          if (
                            item.type === "inputText" &&
                            typeof item.text === "string"
                          ) {
                            content.push({ type: "text", text: item.text });
                          } else if (
                            item.type === "inputImage" &&
                            item.imageBytes
                          ) {
                            const b64 = Buffer.isBuffer(item.imageBytes)
                              ? item.imageBytes.toString("base64")
                              : Buffer.from(item.imageBytes).toString("base64");
                            content.push({
                              type: "image",
                              data: b64,
                              mimeType: item.mediaType || "image/png",
                            });
                          }
                        }
                      } else {
                        content.push({
                          type: "text",
                          text: JSON.stringify(result),
                        });
                      }
                    } else {
                      content.push({
                        type: "text",
                        text: JSON.stringify(result ?? { success: true }),
                      });
                    }

                    return { content: content as any, details: {} };
                  } catch (err: any) {
                    return {
                      content: [
                        {
                          type: "text",
                          text: JSON.stringify({
                            success: false,
                            error: err?.message || "tool_execution_failed",
                          }),
                        },
                      ],
                      details: {},
                    };
                  }
                },
              });
            }
          }
        },
      ],
    });
    await resourceLoader.reload();

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 2 },
    });

    const { session } = await createAgentSession({
      model,
      modelRuntime,
      resourceLoader,
      noTools: "builtin",
      sessionManager: SessionManager.inMemory(),
      settingsManager,
    });

    let finalAnswer = "";

    const unsubscribe = session.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        finalAnswer += event.assistantMessageEvent.delta;
        options?.onText?.(event.assistantMessageEvent.delta);
      }
    });

    if (options?.signal) {
      if (options.signal.aborted) {
        session.dispose();
        throw new Error("AI turn aborted.");
      }
      options.signal.addEventListener("abort", () => {
        session.abort().catch(() => undefined);
      });
    }

    try {
      await session.prompt("프레젠테이션 작업을 시작해 주세요.");
    } finally {
      unsubscribe();
      session.dispose();
    }

    if (!finalAnswer) {
      const messages = session.agent.state.messages;
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === "assistant" && Array.isArray((msg as any).content)) {
          for (const part of (msg as any).content) {
            if (part.type === "text" && part.text) {
              finalAnswer = part.text;
              break;
            }
          }
        }
        if (finalAnswer) break;
      }
    }

    return finalAnswer;
  }
}
