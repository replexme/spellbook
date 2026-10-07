/* SPDX-License-Identifier: MPL-2.0 */
const ZERO_TOKENS = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
};
function tokenTotals(value) {
  const item = value;
  if (!item || typeof item !== "object") return null;
  const count = (key) => {
    const number = item[key];
    return typeof number === "number" && Number.isFinite(number) && number >= 0
      ? number
      : 0;
  };
  if (typeof item.totalTokens !== "number") return null;
  return {
    totalTokens: count("totalTokens"),
    inputTokens: count("inputTokens"),
    cachedInputTokens: count("cachedInputTokens"),
    cacheWriteInputTokens: count("cacheWriteInputTokens"),
    outputTokens: count("outputTokens"),
  };
}
function tokenUsageGrowth(start, end, calls) {
  const grow = (key) => Math.max(0, end[key] - start[key]);
  const cacheRead = grow("cachedInputTokens");
  return {
    calls,
    input: Math.max(0, grow("inputTokens") - cacheRead),
    output: grow("outputTokens"),
    cacheRead,
    cacheWrite: grow("cacheWriteInputTokens"),
  };
}

module.exports = { ZERO_TOKENS, tokenTotals, tokenUsageGrowth };
