import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth", () => ({ sessionFromRequest: async () => null }));

import { HttpError, routeError } from "./http";

afterEach(() => vi.restoreAllMocks());

describe("route errors", () => {
  it("keeps explicit HTTP reasons", async () => {
    const response = routeError(new HttpError(404, "document_not_found"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "document_not_found" });
  });

  it("keeps reason codes thrown by the document libraries", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = routeError(new Error("invalid_model_settings"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_model_settings" });
  });

  it("never returns raw exception text to the browser", async () => {
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const response = routeError(
      new Error('relation "spellbook_documents" does not exist'),
    );
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string; errorId: string };
    expect(body.error).toBe("unexpected_error");
    expect(body.errorId).toMatch(/^[0-9A-F]{8}$/);
    expect(JSON.stringify(body)).not.toContain("spellbook_documents");
    // The server log carries the same reference with the detail.
    expect(String(logged.mock.calls[0]?.[0])).toContain(body.errorId);
  });
});
