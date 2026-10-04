import { describe, expect, it } from "vitest";

import { SELF_HOSTED_PLAN, accountPlan } from "./account-plan";

describe("self-hosted account plan", () => {
  it("shows no ads and sets no storage limit", async () => {
    const plan = await accountPlan({
      accountId: "local:abc",
      email: "owner@example.test",
      admin: true,
      token: "",
    });
    expect(plan).toBe(SELF_HOSTED_PLAN);
    expect(plan).toEqual({
      id: "self_hosted",
      showsAds: false,
      storageLimitBytes: null,
      documentLimit: null,
    });
  });
});
