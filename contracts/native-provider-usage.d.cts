export type TokenTotals = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
};
export const ZERO_TOKENS: TokenTotals;
export function tokenTotals(value: unknown): TokenTotals | null;
export function tokenUsageGrowth(
  start: TokenTotals,
  end: TokenTotals,
  calls: number,
): {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};
