import { describe, expect, it } from "vitest";

import {
  storageAmount,
  storageFull,
  storageLimits,
  storageQuotaProblem,
} from "./storage-quota";

const GIB = 1024 * 1024 * 1024;
const free = { bytes: GIB, documents: 100 };

describe("storage quota", () => {
  it("reads the limits from the account plan", () => {
    expect(
      storageLimits({ storageLimitBytes: GIB, documentLimit: 100 }),
    ).toEqual(free);
    expect(
      storageLimits({ storageLimitBytes: null, documentLimit: null }),
    ).toBeNull();
    expect(
      storageLimits({ storageLimitBytes: 50 * GIB, documentLimit: null }),
    ).toEqual({ bytes: 50 * GIB, documents: null });
  });

  it("refuses a new file at the file limit, not before", () => {
    const usage = { bytes: 0, documents: 99 };
    expect(storageQuotaProblem(usage, free, { newDocument: true })).toBeNull();
    expect(
      storageQuotaProblem({ ...usage, documents: 100 }, free, {
        newDocument: true,
      }),
    ).toBe("document_limit_reached");
    // A save to an existing file does not count as a new file.
    expect(storageQuotaProblem({ ...usage, documents: 100 }, free)).toBeNull();
  });

  it("refuses a write that would pass the byte limit", () => {
    expect(
      storageQuotaProblem({ bytes: GIB - 10, documents: 1 }, free, {
        addingBytes: 10,
      }),
    ).toBeNull();
    expect(
      storageQuotaProblem({ bytes: GIB - 10, documents: 1 }, free, {
        addingBytes: 11,
      }),
    ).toBe("storage_full");
    expect(
      storageQuotaProblem({ bytes: GIB + 1, documents: 500 }, null, {
        newDocument: true,
        addingBytes: 1,
      }),
    ).toBeNull();
    expect(
      storageQuotaProblem(
        { bytes: 0, documents: 500 },
        { bytes: GIB, documents: null },
        { newDocument: true },
      ),
    ).toBeNull();
  });

  it("knows when nothing new fits", () => {
    expect(storageFull({ bytes: GIB, documents: 1 }, free)).toBe(true);
    expect(storageFull({ bytes: 0, documents: 100 }, free)).toBe(true);
    expect(storageFull({ bytes: 0, documents: 99 }, free)).toBe(false);
    expect(storageFull({ bytes: GIB, documents: 100 }, null)).toBe(false);
  });

  it("states amounts the way people read them", () => {
    expect(storageAmount(312 * 1024 * 1024)).toBe("312MB");
    expect(storageAmount(GIB)).toBe("1GB");
    expect(storageAmount(1.25 * GIB)).toBe("1.3GB");
  });
});
