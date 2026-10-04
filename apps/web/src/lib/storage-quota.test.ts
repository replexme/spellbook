import { describe, expect, it } from "vitest";

import {
  FREE_STORAGE_LIMITS,
  storageAmount,
  storageLimits,
  storageQuotaProblem,
} from "./storage-quota";

describe("storage quota", () => {
  it("limits free accounts to 1GB and 100 files and lifts limits for Pro", () => {
    expect(storageLimits("free")).toEqual({
      bytes: 1024 * 1024 * 1024,
      documents: 100,
    });
    expect(storageLimits("pro")).toBeNull();
  });

  it("refuses a new file at the file limit, not before", () => {
    const usage = { bytes: 0, documents: 99 };
    expect(
      storageQuotaProblem(usage, FREE_STORAGE_LIMITS, { newDocument: true }),
    ).toBeNull();
    expect(
      storageQuotaProblem({ ...usage, documents: 100 }, FREE_STORAGE_LIMITS, {
        newDocument: true,
      }),
    ).toBe("document_limit_reached");
    // A save to an existing file does not count as a new file.
    expect(
      storageQuotaProblem({ ...usage, documents: 100 }, FREE_STORAGE_LIMITS),
    ).toBeNull();
  });

  it("refuses a write that would pass the byte limit", () => {
    const limit = FREE_STORAGE_LIMITS.bytes;
    expect(
      storageQuotaProblem(
        { bytes: limit - 10, documents: 1 },
        FREE_STORAGE_LIMITS,
        {
          addingBytes: 10,
        },
      ),
    ).toBeNull();
    expect(
      storageQuotaProblem(
        { bytes: limit - 10, documents: 1 },
        FREE_STORAGE_LIMITS,
        {
          addingBytes: 11,
        },
      ),
    ).toBe("storage_full");
    expect(
      storageQuotaProblem({ bytes: limit + 1, documents: 1 }, null, {
        newDocument: true,
        addingBytes: 1,
      }),
    ).toBeNull();
  });

  it("states amounts the way people read them", () => {
    expect(storageAmount(312 * 1024 * 1024)).toBe("312MB");
    expect(storageAmount(1024 * 1024 * 1024)).toBe("1GB");
    expect(storageAmount(1.25 * 1024 * 1024 * 1024)).toBe("1.3GB");
  });
});
