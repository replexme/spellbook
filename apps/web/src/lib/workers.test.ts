import { afterEach, describe, expect, it, vi } from "vitest";

import { callAiAccount, enqueueWorkerJob } from "./workers";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("self-hosted worker transport", () => {
  it.each(["document", "ai"] as const)(
    "dispatches %s jobs to the configured private service URL",
    async (target) => {
      vi.stubEnv(
        target === "document"
          ? "SPELLBOOK_DOCUMENT_WORKER_URL"
          : "SPELLBOOK_AI_WORKER_URL",
        `http://${target}:8080`,
      );
      vi.stubEnv("SPELLBOOK_INTERNAL_TOKEN", "internal-test-token");
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 202 }));
      vi.stubGlobal("fetch", fetcher);
      await enqueueWorkerJob("job-1", target, "/internal/jobs/run", {
        jobId: "job-1",
      });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls[0]![0]).toBe(
        `http://${target}:8080/internal/jobs/run`,
      );
      const headers = new Headers(fetcher.mock.calls[0]![1]?.headers);
      expect(headers.get("x-spellbook-internal-token")).toBe(
        "internal-test-token",
      );
    },
  );

  it("returns account data from the local AI connector", async () => {
    vi.stubEnv("SPELLBOOK_AI_WORKER_URL", "http://ai:8080");
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ account: { type: "chatgpt" } })),
    );
    await expect(
      callAiAccount("/internal/account/status", {
        accountId: "owner",
        email: "owner@test",
      }),
    ).resolves.toMatchObject({ account: { type: "chatgpt" } });
  });
});
