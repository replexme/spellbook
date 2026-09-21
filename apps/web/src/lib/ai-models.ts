import type {
  AiProviderId,
  AvailableModel,
  ModelSettings,
} from "../../../../contracts/ai-models";

export type { AiProviderId, AvailableModel, ModelSettings };

export const VALID_AI_PROVIDERS: readonly AiProviderId[] = [
  "codex",
  "claude_code",
  "openai_api",
  "anthropic_api",
  "gemini_api",
  "openrouter_api",
  "custom_api",
] as const;

export function parseModelSettings(value: unknown): ModelSettings | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_model_settings");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) => !["provider", "model", "effort", "customBaseUrl"].includes(key),
    ) ||
    (input.provider !== undefined &&
      !VALID_AI_PROVIDERS.includes(input.provider as AiProviderId)) ||
    typeof input.model !== "string" ||
    !input.model ||
    input.model.length > 120 ||
    typeof input.effort !== "string" ||
    !input.effort ||
    input.effort.length > 24 ||
    (input.customBaseUrl !== undefined &&
      (typeof input.customBaseUrl !== "string" ||
        input.customBaseUrl.length > 255))
  )
    throw new Error("invalid_model_settings");
  return {
    ...(input.provider
      ? { provider: input.provider as ModelSettings["provider"] }
      : {}),
    model: input.model,
    effort: input.effort,
    ...(typeof input.customBaseUrl === "string" && input.customBaseUrl.trim()
      ? { customBaseUrl: input.customBaseUrl.trim() }
      : {}),
  };
}

export function supportsSettings(
  models: AvailableModel[],
  settings: ModelSettings,
): boolean {
  return !!models
    .find(
      (item) =>
        item.model === settings.model &&
        (!settings.provider || item.provider === settings.provider),
    )
    ?.supportedReasoningEfforts.some(
      (item) => item.reasoningEffort === settings.effort,
    );
}

export function openAiModels(): AvailableModel[] {
  return [
    {
      provider: "openai_api",
      model: "gpt-4o",
      displayName: "GPT-4o (OpenAI API)",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "기본" },
      ],
      isDefault: true,
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
  ];
}

export function anthropicModels(): AvailableModel[] {
  return [
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
      isDefault: true,
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
    {
      provider: "anthropic_api",
      model: "claude-3-5-haiku-20241022",
      displayName: "Claude 3.5 Haiku (Anthropic API)",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "기본" },
      ],
      isDefault: false,
    },
  ];
}

export function geminiModels(): AvailableModel[] {
  return [
    {
      provider: "gemini_api",
      model: "gemini-2.5-flash",
      displayName: "Gemini 2.5 Flash (Google AI)",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "기본" },
      ],
      isDefault: true,
    },
    {
      provider: "gemini_api",
      model: "gemini-2.5-pro",
      displayName: "Gemini 2.5 Pro (Google AI)",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "빠르게" },
        { reasoningEffort: "medium", description: "보통" },
        { reasoningEffort: "high", description: "꼼꼼하게" },
      ],
      isDefault: false,
    },
    {
      provider: "gemini_api",
      model: "gemini-1.5-pro",
      displayName: "Gemini 1.5 Pro (Google AI)",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "기본" },
      ],
      isDefault: false,
    },
  ];
}

export function openRouterModels(): AvailableModel[] {
  return [
    {
      provider: "openrouter_api",
      model: "deepseek/deepseek-chat",
      displayName: "DeepSeek V3 (OpenRouter)",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "기본" },
      ],
      isDefault: true,
    },
    {
      provider: "openrouter_api",
      model: "deepseek/deepseek-r1",
      displayName: "DeepSeek R1 (OpenRouter)",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "high", description: "심층 추론" },
      ],
      isDefault: false,
    },
  ];
}
