import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  owned: true,
  statements: [] as unknown[][],
}));
vi.mock("@/lib/browser-session", () => ({ requireBrowserOrigin: () => {} }));
vi.mock("@/lib/http", () => ({
  requireSession: async () => ({ accountId: "owner" }),
  HttpError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  routeError: (error: any) =>
    Response.json({ error: error.message }, { status: error.status ?? 500 }),
}));
vi.mock("@/lib/db", () => {
  const sql = Object.assign(
    async (parts: TemplateStringsArray, ...values: unknown[]) => {
      state.statements.push(values);
      return parts.join("?").includes("select 1 from spellbook_documents")
        ? state.owned
          ? [{}]
          : []
        : [{ id: 1 }];
    },
    { json: (value: unknown) => value },
  );
  return { db: () => sql, ensureSchema: async () => {} };
});
import { POST } from "./route";
const context = {
  params: Promise.resolve({ id: "11111111-2222-4333-8444-555555555555" }),
};
const send = (body: unknown) =>
  POST(
    new Request("https://spellbook.test/error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    context,
  );
const failure = {
  errorReference: "ABCDEF12",
  code: "product_document_changed",
  occurredAt: "2026-10-07T13:38:40.851Z",
};
beforeEach(() => {
  state.owned = true;
  state.statements = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});
it("keeps the same reference and time, excluding content and free-form exception text", async () => {
  expect(
    (await send({ ...failure, documentContent: "private", prompt: "private" }))
      .status,
  ).toBe(204);
  expect(state.statements[1]).toContainEqual(failure);
  expect(JSON.stringify(state.statements)).not.toContain("private");
  expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining('"errorReference":"ABCDEF12"'),
  );
});
it("refuses another person's document without recording the error", async () => {
  state.owned = false;
  expect((await send(failure)).status).toBe(404);
  expect(state.statements).toHaveLength(1);
});
it("rejects invalid identifiers and arbitrary text before database access", async () => {
  for (const body of [
    null,
    { ...failure, errorReference: 12345678 },
    { ...failure, code: "private document content" },
    { ...failure, occurredAt: "invalid" },
  ])
    expect((await send(body)).status).toBe(400);
  expect(state.statements).toHaveLength(0);
});
