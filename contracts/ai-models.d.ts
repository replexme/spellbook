export type AiProviderId =
  | "codex"
  | "claude_code"
  | "openai_api"
  | "anthropic_api";

/** Public account-backed model catalog; supports subscriptions and user-provided API keys. */
export interface AvailableModel {
  provider?: AiProviderId;
  model: string;
  displayName: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: Array<{
    reasoningEffort: string;
    description: string;
  }>;
  isDefault: boolean;
}
export interface ModelSettings {
  provider?: AiProviderId;
  model: string;
  effort: string;
}
