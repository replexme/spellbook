import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  readBrowserDocument,
  RELAYED_FILE_MAX_BYTES,
  writeBrowserDocument,
} from "./browser-document-transfer";

const PPTX =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const base = "/api/documents/d/browser";
const file = new Uint8Array([0x50, 0x4b, 1, 2, 3]).buffer;
const digest = createHash("sha256").update(new Uint8Array(file)).digest("hex");
const revision = `"v1:${digest}"`;

function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

describe("reading the editor's file", () => {
  it("reads straight from storage and checks the bytes hash to the revision", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url) === `${base}/source`
        ? json({ revision, url: "https://storage.invalid/read" })
        : new Response(file.slice(0)),
    );
    const read = await readBrowserDocument(base, revision, 100, fetcher);
    expect(read.revision).toBe(revision);
    expect(new Uint8Array(read.bytes)).toEqual(new Uint8Array(file));
    expect(fetcher.mock.calls.map((call) => String(call[0]))).toEqual([
      `${base}/source`,
      "https://storage.invalid/read",
    ]);
  });

  it("refuses storage bytes that are not the opened revision", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url) === `${base}/source`
        ? json({ revision, url: "https://storage.invalid/read" })
        : new Response(new Uint8Array([0x50, 0x4b, 9])),
    );
    await expect(
      readBrowserDocument(base, revision, 100, fetcher),
    ).rejects.toThrow("browser_document_identity_mismatch");
  });

  it("falls back to the app when storage cannot be reached", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url) === `${base}/source`)
        return json({ revision, url: "https://storage.invalid/read" });
      if (String(url).startsWith("https://storage.invalid"))
        throw new TypeError("blocked");
      return new Response(file.slice(0), {
        headers: { etag: revision, "content-type": PPTX },
      });
    });
    const read = await readBrowserDocument(base, revision, 100, fetcher);
    expect(read.bytes.byteLength).toBe(5);
    expect(String(fetcher.mock.calls.at(-1)![0])).toBe(`${base}/contents`);
  });
});

describe("saving the editor's file", () => {
  it("writes straight to storage, then asks the app to check and save it", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url) === `${base}/saves`)
        return json({
          direct: true,
          url: "https://storage.invalid/write",
          headers: { "content-type": PPTX },
          token: "t",
        });
      if (String(url) === "https://storage.invalid/write")
        return new Response(null, { status: 200 });
      expect(JSON.parse(String(init?.body))).toEqual({ token: "t" });
      return json(
        { revision: '"v2:x"', unchanged: false },
        { headers: { etag: '"v2:x"' } },
      );
    });
    await expect(
      writeBrowserDocument(base, revision, file, fetcher),
    ).resolves.toEqual({ revision: '"v2:x"', unchanged: false });
    expect(fetcher.mock.calls.map((call) => String(call[0]))).toEqual([
      `${base}/saves`,
      "https://storage.invalid/write",
      `${base}/saves/complete`,
    ]);
    expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({
      "if-match": revision,
    });
  });

  it("relays a small file through the app when storage is blocked", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url) === `${base}/saves`)
        return json({
          direct: true,
          url: "https://storage.invalid/w",
          token: "t",
        });
      if (String(url).startsWith("https://storage.invalid"))
        throw new TypeError("blocked");
      return json({ revision: '"v2:x"', unchanged: false });
    });
    await expect(
      writeBrowserDocument(base, revision, file, fetcher),
    ).resolves.toMatchObject({ revision: '"v2:x"' });
    expect(fetcher.mock.calls.at(-1)![1]?.method).toBe("PUT");
  });

  it("says the network blocks storage instead of relaying a large file", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url) === `${base}/saves`)
        return json({
          direct: true,
          url: "https://storage.invalid/w",
          token: "t",
        });
      throw new TypeError("blocked");
    });
    await expect(
      writeBrowserDocument(
        base,
        revision,
        new ArrayBuffer(RELAYED_FILE_MAX_BYTES + 1),
        fetcher,
      ),
    ).rejects.toThrow("direct_upload_blocked");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("passes on the reason a save was refused", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      json({ error: "storage_full" }, { status: 403 }),
    );
    await expect(
      writeBrowserDocument(base, revision, file, fetcher),
    ).rejects.toThrow("storage_full");
  });
});
