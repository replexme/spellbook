const MODEL_INPUT_FIELDS = [
  "calls",
  "fullTextBytes",
  "sentTextBytes",
  "imageCount",
  "imageBytes",
] as const;
const PROVIDER_USAGE_FIELDS = [
  "providerCalls",
  "providerInputTokens",
  "providerOutputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
] as const;

function validCount(value: unknown) {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) < 1_000_000_000
  );
}

export function validatedNativeModelInput(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const counts = value as Record<string, unknown>;
  if (!MODEL_INPUT_FIELDS.every((field) => validCount(counts[field])))
    return null;
  const fields: readonly string[] = PROVIDER_USAGE_FIELDS.every((field) =>
    validCount(counts[field]),
  )
    ? [...MODEL_INPUT_FIELDS, ...PROVIDER_USAGE_FIELDS]
    : MODEL_INPUT_FIELDS;
  const timing = ["elapsedMs", "hostMs", "modelMs", "hostCalls"].filter(
    (field) => validCount(counts[field]),
  );
  return Object.fromEntries(
    [...fields, ...timing].map((field) => [field, counts[field]]),
  );
}
