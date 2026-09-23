import { describe, expect, it } from "vitest";
import { wopiLockConflict } from "./wopi-lock-policy";

describe("WOPI lock transitions", () => {
  it("permits first acquisition, renewal and owner-authorized replacement", () => {
    expect(wopiLockConflict("LOCK", null, "a", null)).toBeNull();
    expect(wopiLockConflict("LOCK", "a", "a", null)).toBeNull();
    expect(wopiLockConflict("LOCK", "a", "b", "a")).toBeNull();
    expect(wopiLockConflict("REFRESH_LOCK", "a", "a", null)).toBeNull();
    expect(wopiLockConflict("UNLOCK", "a", "a", null)).toBeNull();
  });
  it("returns the exact existing lock on every mismatch (including unlocked files)", () => {
    expect(wopiLockConflict("LOCK", "a", "b", null)).toBe("a");
    expect(wopiLockConflict("LOCK", "a", "b", "wrong")).toBe("a");
    expect(wopiLockConflict("REFRESH_LOCK", "a", "b", null)).toBe("a");
    expect(wopiLockConflict("UNLOCK", "a", "b", null)).toBe("a");
    expect(wopiLockConflict("REFRESH_LOCK", null, "a", null)).toBe("");
    expect(wopiLockConflict("UNLOCK", null, "a", null)).toBe("");
  });
});
