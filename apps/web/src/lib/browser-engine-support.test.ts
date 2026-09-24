import { describe, expect, it } from "vitest";

import { browserEngineSupported } from "./browser-engine-support";

const chromium = (version: string, mobile = false) => ({
  brands: [
    { brand: "Not)A;Brand", version: "99" },
    { brand: "Chromium", version },
    { brand: "Google Chrome", version },
  ],
  mobile,
});

describe("browser Office engine support", () => {
  it("accepts Chrome and Edge that isolate the editor frame", () => {
    expect(browserEngineSupported(chromium("137"))).toBe(true);
    expect(browserEngineSupported(chromium("146", true))).toBe(true);
  });

  it("refuses older Chromium, Safari and Firefox", () => {
    expect(browserEngineSupported(chromium("136"))).toBe(false);
    expect(browserEngineSupported(chromium("145", true))).toBe(false);
    // Safari and Firefox expose no user-agent client hints.
    expect(browserEngineSupported(undefined)).toBe(false);
    expect(browserEngineSupported({ brands: [], mobile: false })).toBe(false);
  });
});
