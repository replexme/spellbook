import { describe, expect, it } from "vitest";
import { validatedNativeModelInput } from "./native-model-input";

describe("native model input receipt", () => {
  const legacy = {
    calls: 2,
    fullTextBytes: 120_000,
    sentTextBytes: 15_000,
    imageCount: 2,
    imageBytes: 8_000,
  };

  it("retains provider cache usage beside the payload counts", () => {
    expect(
      validatedNativeModelInput({
        ...legacy,
        providerCalls: 3,
        providerInputTokens: 20_000,
        providerOutputTokens: 600,
        cacheReadTokens: 12_000,
        cacheWriteTokens: 2_000,
      }),
    ).toMatchObject({ calls: 2, providerCalls: 3, cacheReadTokens: 12_000 });
  });

  it("accepts prior receipts and rejects invalid base counts", () => {
    expect(validatedNativeModelInput(legacy)).toEqual(legacy);
    expect(validatedNativeModelInput({ ...legacy, imageBytes: -1 })).toBeNull();
    expect(
      validatedNativeModelInput({ ...legacy, cacheReadTokens: -1 }),
    ).toEqual(legacy);
  });
});
