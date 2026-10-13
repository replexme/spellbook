import type { AiWorkerCallback, NativeJob } from "./types.js";
import { LocalStorage, type ObjectStore } from "./local-storage.js";

export class JobResultStore {
  private readonly running = new Map<string, Promise<AiWorkerCallback>>();
  constructor(private readonly storage: ObjectStore = new LocalStorage()) {}

  async execute(
    job: NativeJob,
    work: () => Promise<AiWorkerCallback>,
  ): Promise<AiWorkerCallback> {
    const ownerPrefix = job.baseGraphObject.match(
      /^(accounts\/[^/]+\/documents\/[^/]+)\/versions\//,
    )?.[1];
    if (!ownerPrefix || !/^[a-zA-Z0-9-]+$/.test(job.jobId))
      throw new Error("Invalid job artifact ownership path.");
    const object = `${ownerPrefix}/jobs/${job.jobId}/worker-result.json`;
    const key = `${job.storageNamespace}/${object}`;
    const existing = this.running.get(key);
    if (existing) return existing;
    const execution = this.loadOrRun(job, object, work);
    this.running.set(key, execution);
    try {
      return await execution;
    } finally {
      if (this.running.get(key) === execution) this.running.delete(key);
    }
  }

  private async loadOrRun(
    job: NativeJob,
    object: string,
    work: () => Promise<AiWorkerCallback>,
  ): Promise<AiWorkerCallback> {
    const file = this.storage.namespace(job.storageNamespace).object(object);
    try {
      const [bytes] = await file.download();
      const result = JSON.parse(bytes.toString("utf8")) as AiWorkerCallback;
      if (
        result.jobId !== job.jobId ||
        result.mode !== job.mode ||
        !["succeeded", "failed"].includes(result.status)
      )
        throw new Error("Stored job result has an invalid identity.");
      return result;
    } catch (error) {
      if (
        !(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          Number(error.code) === 404
        )
      )
        throw error;
    }
    const result = await work();
    try {
      await file.save(JSON.stringify(result), {
        createIfAbsent: true,
        controlReceipt: true,
      });
    } catch (error) {
      if (
        !(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          Number(error.code) === 412
        )
      )
        throw error;
      // Another instance won the race. Reuse its durable result consistently.
      return this.loadOrRun(job, object, work);
    }
    return result;
  }
}
