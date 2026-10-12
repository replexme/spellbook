import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  job: {} as Record<string, unknown>,
  queries: [] as string[],
}));
vi.mock("./db", () => {
  const sql = Object.assign(
    async (parts: TemplateStringsArray) => {
      const query = parts.join("?");
      state.queries.push(query);
      if (query.includes("select * from spellbook_jobs where id"))
        return [state.job];
      if (query.includes("returning id")) return [{ id: "job" }];
      return [];
    },
    { json: (value: unknown) => value },
  );
  return {
    ensureSchema: async () => {},
    db: () =>
      Object.assign(sql, {
        begin: async (fn: (tx: typeof sql) => unknown) => fn(sql),
      }),
  };
});
vi.mock("./storage", () => ({
  storageNamespace: vi.fn(),
  getJsonObject: vi.fn(),
  getObject: vi.fn(),
  putObject: vi.fn(),
}));
vi.mock("./workers", () => ({ enqueueWorkerJob: vi.fn() }));
import { handleWorkerCallback } from "./orchestration";

beforeEach(() => {
  state.queries = [];
  state.job = {
    id: "job",
    status: "running",
    version_id: "normal-base",
    document_id: "doc",
  };
});
describe("failed jobs preserve usable document versions", () => {
  it("a failed file check can fail only its unfinished output version", async () => {
    state.job.job_type = "scan_render";
    await handleWorkerCallback({
      jobId: "job",
      status: "failed",
      error: "render_failed",
    });
    const updates = state.queries.filter((query) =>
      query.includes("update spellbook_versions"),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain("status = 'processing'");
    expect(updates[0]).toContain("kind in ('original', 'candidate')");
  });
  it("ignores a late failure for an already successful job", async () => {
    state.job.status = "succeeded";
    await handleWorkerCallback({ jobId: "job", status: "failed" });
    expect(state.queries.some((query) => query.includes("update"))).toBe(false);
  });
});
