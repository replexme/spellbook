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
] as const;

export function parseModelSettings(value: unknown): ModelSettings | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_model_settings");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) => !["provider", "model", "effort"].includes(key),
    ) ||
    (input.provider !== undefined &&
      !VALID_AI_PROVIDERS.includes(input.provider as AiProviderId)) ||
    typeof input.model !== "string" ||
    !input.model ||
    input.model.length > 120 ||
    typeof input.effort !== "string" ||
    !input.effort ||
    input.effort.length > 24
  )
    throw new Error("invalid_model_settings");
  return {
    ...(input.provider
      ? { provider: input.provider as ModelSettings["provider"] }
      : {}),
    model: input.model,
    effort: input.effort,
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
