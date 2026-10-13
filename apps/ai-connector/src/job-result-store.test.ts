import { describe, expect, it, vi } from "vitest";
import { JobResultStore } from "./job-result-store.js";
import type { ObjectStore } from "./local-storage.js";
import type { AiWorkerCallback, NativeJob } from "./types.js";

const job = {
  jobId: "job-1",
  mode: "native",
  storageNamespace: "local",
  baseGraphObject:
    "accounts/account/documents/doc/versions/base/render/graph.json",
} as NativeJob;
const result: AiWorkerCallback = {
  jobId: "job-1",
  mode: "native",
  status: "succeeded",
  result: { summary: "done" },
};
describe("durable AI results", () => {
  it("reuses a completed result across instances instead of spending another AI turn", async () => {
    let saved: string | undefined;
    const file = {
      download: vi.fn(async () => {
        if (!saved) throw { code: 404 };
        return [Buffer.from(saved)];
      }),
      save: vi.fn(async (value: string) => {
        saved = value;
      }),
    };
    const storage = {
      namespace: () => ({ object: () => file }),
    } as unknown as ObjectStore;
    const work = vi.fn(async () => result);
    expect(await new JobResultStore(storage).execute(job, work)).toEqual(
      result,
    );
    expect(await new JobResultStore(storage).execute(job, work)).toEqual(
      result,
    );
    expect(work).toHaveBeenCalledTimes(1);
  });
  it("does not execute duplicate simultaneous deliveries within one worker", async () => {
    const file = {
      download: vi.fn().mockRejectedValue({ code: 404 }),
      save: vi.fn(),
    };
    const storage = {
      namespace: () => ({ object: () => file }),
    } as unknown as ObjectStore;
    const store = new JobResultStore(storage);
    const work = vi.fn(async () => result);
    await Promise.all([store.execute(job, work), store.execute(job, work)]);
    expect(work).toHaveBeenCalledTimes(1);
  });
  it("fails closed on storage outages rather than repeating an expensive job", async () => {
    const file = { download: vi.fn().mockRejectedValue({ code: 503 }) };
    const storage = {
      namespace: () => ({ object: () => file }),
    } as unknown as ObjectStore;
    const work = vi.fn();
    await expect(
      new JobResultStore(storage).execute(job, work),
    ).rejects.toMatchObject({ code: 503 });
    expect(work).not.toHaveBeenCalled();
  });
});
