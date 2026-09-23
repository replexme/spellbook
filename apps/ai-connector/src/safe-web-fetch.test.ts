import { describe, expect, it, vi, beforeEach } from "vitest";
import { fetchPublicPage, isPublicAddress } from "./safe-web-fetch.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("undici", () => {
  const agent = vi.fn(function (this: object, options: unknown) { Object.assign(this, { options, destroy: vi.fn() }); });
  return { Agent: agent, fetch: vi.fn() };
});

import { lookup } from "node:dns/promises";
import { Agent, fetch } from "undici";

const resolve = vi.mocked(lookup);
const request = vi.mocked(fetch);
const createAgent = vi.mocked(Agent);

beforeEach(() => { vi.clearAllMocks(); });

describe("public web egress", () => {
  it("rejects metadata, RFC1918, loopback, link-local, IPv6 ULA and mapped addresses", () => {
    for (const address of ["169.254.169.254", "10.0.0.1", "172.31.1.5", "192.168.1.1", "127.5.5.5", "0.0.0.0", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "224.0.0.1"]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("rejects invalid schemes, credentials and internal hosts before network access", async () => {
    for (const url of ["bad url", "http://example.com", "https://user:pass@example.com", "https://metadata.google.internal", "https://localhost"]) {
      await expect(fetchPublicPage(url)).rejects.toThrow();
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects any private result in a mixed DNS answer without connecting", async () => {
    resolve.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }, { address: "169.254.169.254", family: 4 }] as never);
    await expect(fetchPublicPage("https://example.com")).rejects.toThrow("web_fetch_non_public_address");
    expect(request).not.toHaveBeenCalled();
  });

  it("pins verified DNS answers and disallows redirects", async () => {
    resolve.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }] as never);
    request.mockResolvedValueOnce({ ok: true, headers: new Headers(), body: [new TextEncoder().encode("page")], status: 200 } as never);
    expect(await fetchPublicPage("https://example.com/path")).toBe("page");
    const options = createAgent.mock.calls[0]![0]!;
    const pinnedLookup = (options as unknown as {
      connect: { lookup: (host: string, options: { all: boolean }, callback: (error: Error | null, address: string) => void) => void };
    }).connect.lookup;
    pinnedLookup("example.com", { all: false }, (error, address) => {
      expect(error).toBeNull();
      expect(address).toBe("8.8.8.8");
    });
    expect(request.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
  });
});
