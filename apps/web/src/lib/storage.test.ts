import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deletePrefix,
  hasStorageCapacity,
  moveObject,
  objectDigest,
  objectHead,
  prefixBytes,
  putObject,
  StorageCapacityError,
  storageReserveBytes,
} from "./storage";
import { routeError } from "./http";

describe("local storage capacity boundary", () => {
  it("keeps a bounded reserve after the complete atomic write", () => {
    const reserve = 512 * 1024 * 1024;
    expect(storageReserveBytes(undefined)).toBe(reserve);
    expect(hasStorageCapacity(reserve + 10, 10, reserve)).toBe(true);
    expect(hasStorageCapacity(reserve + 9, 10, reserve)).toBe(false);
    expect(storageReserveBytes(String(64 * 1024 * 1024))).toBe(
      64 * 1024 * 1024,
    );
    expect(() => storageReserveBytes("0")).toThrow();
    expect(() => storageReserveBytes("1.5")).toThrow();
  });

  it("reports capacity exhaustion as HTTP 507 instead of an opaque server error", async () => {
    const response = routeError(new StorageCapacityError());
    expect(response.status).toBe(507);
    await expect(response.json()).resolves.toEqual({
      error: "storage_capacity_exhausted",
    });
  });
});

describe("local storage folders", () => {
  afterEach(() => vi.unstubAllEnvs());

  async function store() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "spellbook-storage-"));
    vi.stubEnv("SPELLBOOK_DATA_DIR", root);
    vi.stubEnv("SPELLBOOK_STORAGE_RESERVE_BYTES", String(64 * 1024 * 1024));
    return root;
  }

  it("hashes a stored file as a stream and reports its first bytes", async () => {
    await store();
    const data = Buffer.concat([Buffer.from("PK"), Buffer.alloc(200_000, 7)]);
    await putObject("a/doc.pptx.incoming", data, "application/pptx");
    const digest = await objectDigest("a/doc.pptx.incoming", 2);
    expect(digest).toEqual({
      size: data.length,
      head: Buffer.from("PK"),
      sha256: createHash("sha256").update(data).digest("hex"),
    });
    expect(await objectDigest("a/missing", 2)).toBeNull();
  });

  it("moves a completed transfer into place", async () => {
    await store();
    await putObject("a/v1/document.pptx.incoming", Buffer.from("PK1"), "x");
    await moveObject("a/v1/document.pptx.incoming", "a/v1/document.pptx");
    expect(await objectHead("a/v1/document.pptx.incoming", 2)).toBeNull();
    expect((await objectHead("a/v1/document.pptx", 2))?.size).toBe(3);
  });

  it("measures and removes a folder", async () => {
    await store();
    await putObject("doc/versions/v1/document.pptx", Buffer.alloc(10), "x");
    await putObject(
      "doc/versions/v1/render/slides/slide-1.png",
      Buffer.alloc(5),
      "x",
    );
    await putObject("doc/versions/v2/document.pptx", Buffer.alloc(7), "x");
    expect(await prefixBytes("doc/")).toBe(22);
    await deletePrefix("doc/versions/v1/");
    expect(await prefixBytes("doc/")).toBe(7);
    expect(await prefixBytes("nothing/")).toBe(0);
  });
});
