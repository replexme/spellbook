import { createHash, randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Session } from "./models";
import { isolatedPostgresTestUrl } from "./postgres-test-schema";

// An in-memory object store with the same contract as storage.ts.
const objects = vi.hoisted(() => new Map<string, Buffer>());
const storage = vi.hoisted(() => ({
  putObject: vi.fn(async (name: string, data: Buffer) => {
    objects.set(name, Buffer.from(data));
  }),
  getObject: vi.fn(async (name: string) => {
    const data = objects.get(name);
    if (!data) throw new Error("not found");
    return data;
  }),
  getJsonObject: vi.fn(async () => ({})),
  deleteObject: vi.fn(async (name: string) => {
    objects.delete(name);
  }),
  moveObject: vi.fn(async (from: string, to: string) => {
    const data = objects.get(from);
    if (!data) throw new Error("not found");
    objects.set(to, data);
    objects.delete(from);
  }),
  objectHead: vi.fn(async (name: string, length: number) => {
    const data = objects.get(name);
    return data ? { size: data.length, head: data.subarray(0, length) } : null;
  }),
  objectDigest: vi.fn(async (name: string, length: number) => {
    const data = objects.get(name);
    return data
      ? {
          size: data.length,
          head: data.subarray(0, length),
          sha256: createHash("sha256").update(data).digest("hex"),
        }
      : null;
  }),
  prefixBytes: vi.fn(async (prefix: string) =>
    [...objects]
      .filter(([name]) => name.startsWith(prefix))
      .reduce((total, [, data]) => total + data.length, 0),
  ),
  deletePrefix: vi.fn(async (prefix: string) => {
    for (const name of [...objects.keys()])
      if (name.startsWith(prefix)) objects.delete(name);
  }),
  directWriteTarget: vi.fn(async (name: string) => ({
    url: `https://storage.invalid/write/${name}`,
    headers: { "content-type": "application/pptx" },
  })),
  directReadUrl: vi.fn(
    async (name: string) => `https://storage.invalid/read/${name}`,
  ),
  storageNamespace: () => "retention-storageNamespace",
  accountPrefix: (account: string, document: string) =>
    `accounts/${Buffer.from(account).toString("base64url")}/documents/${document}`,
}));
vi.mock("./storage", () => storage);
const workers = vi.hoisted(() => ({
  enqueueWorkerJob: vi.fn(async (..._args: unknown[]) => {}),
  callAiAccount: vi.fn(),
}));
vi.mock("./workers", () => workers);
vi.mock("./db", async (original) => ({
  ...(await original<typeof import("./db")>()),
  ensureSchema: async () => {},
}));

import { db } from "./db";
import {
  handleWorkerCallback,
  recoverStaleDocumentJobs,
  retryDocumentProcessing,
} from "./orchestration";
import { maintainDocumentStorage } from "./version-retention";
import { accountStorageUsage } from "./storage-usage";
import {
  browserDocumentSource,
  completeBrowserSave,
  createBrowserDocumentLaunch,
  startBrowserSave,
} from "./browser-session";

const enabled = process.env.SPELLBOOK_VERSION_INTEGRATION === "1";
const schema = `spellbook_retention_${randomUUID().replaceAll("-", "")}`;
const origin = "https://spellbook.integration.invalid";

function owner(): Session {
  return {
    accountId: `retention-${randomUUID()}`,
    email: "owner@example.test",
    admin: true,
    token: "integration",
  };
}

beforeAll(async () => {
  if (!enabled) return;
  vi.stubEnv("NEXT_PUBLIC_APP_URL", origin);
  vi.stubEnv(
    "SPELLBOOK_BROWSER_OFFICE_URL",
    "https://office.spellbook.integration.invalid",
  );
  vi.stubEnv(
    "SPELLBOOK_WOPI_SECRET",
    "integration-wopi-secret-that-is-long-enough",
  );
  vi.stubEnv("DATABASE_URL", await isolatedPostgresTestUrl(schema));
  const actual = await vi.importActual<typeof import("./db")>("./db");
  await actual.ensureSchema();
});
afterAll(async () => {
  if (!enabled) return;
  await db().unsafe(`drop schema if exists "${schema}" cascade`);
  await db().end();
  vi.unstubAllEnvs();
});
beforeEach(() => {
  workers.enqueueWorkerJob.mockClear();
  workers.enqueueWorkerJob.mockImplementation(async () => {});
});

function prefix(session: Session, documentId: string) {
  return storage.accountPrefix(session.accountId, documentId);
}

/** A document whose import is still being checked. */
async function importing(session: Session, job: Record<string, unknown>) {
  const documentId = randomUUID();
  const versionId = randomUUID();
  const jobId = randomUUID();
  await db().begin(async (sql) => {
    await sql`insert into spellbook_documents (id,account_id,file_name,status,original_version_id,current_version_id)
      values (${documentId},${session.accountId},'deck.pptx','processing',${versionId},${versionId})`;
    await sql`insert into spellbook_versions (id,document_id,kind,status,document_object)
      values (${versionId},${documentId},'original','processing',${`${prefix(session, documentId)}/versions/${versionId}/document.pptx`})`;
    await sql`insert into spellbook_jobs (id,job_type,document_id,version_id,status,payload,created_at,updated_at,dispatched_at,delivery_count)
      values (${jobId},'scan_render',${documentId},${versionId},'queued',
        ${sql.json({ jobId, inputObject: "in.pptx", outputPrefix: `${prefix(session, documentId)}/versions/${versionId}/render` })},
        ${job.createdAt as Date},${job.updatedAt as Date},${(job.dispatchedAt as Date | null) ?? null},${(job.deliveryCount as number) ?? 0})`;
  });
  return { documentId, versionId, jobId };
}

const ago = (seconds: number) => new Date(Date.now() - seconds * 1000);

describe.skipIf(!enabled)(
  "every document job finishes or visibly fails",
  () => {
    it("sends a job that never reached its queue again, on the upload line", async () => {
      const session = owner();
      const f = await importing(session, {
        createdAt: ago(60),
        updatedAt: ago(30),
        dispatchedAt: null,
      });
      await recoverStaleDocumentJobs({ accountId: session.accountId });
      expect(workers.enqueueWorkerJob).toHaveBeenCalledWith(
        f.jobId,
        "document",
        "/internal/jobs/scan-render",
        expect.objectContaining({ jobId: f.jobId }),
        { attempt: 1, lane: "upload" },
      );
      const [job] =
        await db()`select * from spellbook_jobs where id=${f.jobId}`;
      expect(job.delivery_count).toBe(1);
      expect(job.dispatched_at).not.toBeNull();
    });

    it("leaves a delivered job alone while its worker may still run it", async () => {
      const session = owner();
      await importing(session, {
        createdAt: ago(600),
        updatedAt: ago(600),
        dispatchedAt: ago(600),
        deliveryCount: 1,
      });
      await recoverStaleDocumentJobs({ accountId: session.accountId });
      expect(workers.enqueueWorkerJob).not.toHaveBeenCalled();
    });

    it("redelivers a lost delivery under a new task name", async () => {
      const session = owner();
      const f = await importing(session, {
        createdAt: ago(1_000),
        updatedAt: ago(970),
        dispatchedAt: ago(970),
        deliveryCount: 1,
      });
      await recoverStaleDocumentJobs({
        accountId: session.accountId,
        documentId: f.documentId,
      });
      expect(workers.enqueueWorkerJob).toHaveBeenCalledOnce();
      expect(workers.enqueueWorkerJob.mock.calls[0]![4]).toEqual({
        attempt: 2,
        lane: "upload",
      });
    });

    it("keeps a failed redelivery queued for the next poll", async () => {
      const session = owner();
      const f = await importing(session, {
        createdAt: ago(60),
        updatedAt: ago(30),
        dispatchedAt: null,
      });
      workers.enqueueWorkerJob.mockRejectedValueOnce(new Error("queue outage"));
      await recoverStaleDocumentJobs({ accountId: session.accountId });
      const [job] =
        await db()`select * from spellbook_jobs where id=${f.jobId}`;
      expect(job).toMatchObject({ status: "queued", error: "queue outage" });
      expect(job.dispatched_at).toBeNull();
    });

    it("fails an import that took too long with a reason, then checks it again on request", async () => {
      const session = owner();
      const f = await importing(session, {
        createdAt: ago(21 * 60),
        updatedAt: ago(20 * 60),
        dispatchedAt: ago(20 * 60),
        deliveryCount: 1,
      });
      await recoverStaleDocumentJobs({ accountId: session.accountId });
      expect(workers.enqueueWorkerJob).not.toHaveBeenCalled();
      const [document] =
        await db()`select status, failure_code from spellbook_documents where id=${f.documentId}`;
      expect(document).toEqual({
        status: "failed",
        failure_code: "processing_timeout",
      });
      const [job] =
        await db()`select status from spellbook_jobs where id=${f.jobId}`;
      expect(job.status).toBe("failed");

      await retryDocumentProcessing(session, f.documentId);
      const [retried] =
        await db()`select status, failure_code from spellbook_documents where id=${f.documentId}`;
      expect(retried).toEqual({ status: "processing", failure_code: null });
      const call = workers.enqueueWorkerJob.mock.calls.at(-1)!;
      expect(call[2]).toBe("/internal/jobs/scan-render");
      // A fresh output folder: the failed attempt's stored result cannot answer.
      expect((call[3] as { outputPrefix: string }).outputPrefix).not.toBe(
        `${prefix(session, f.documentId)}/versions/${f.versionId}/render`,
      );
      await expect(
        retryDocumentProcessing(session, f.documentId),
      ).rejects.toMatchObject({
        status: 409,
        message: "document_not_retryable",
      });
    });

    it("does not offer a second check for a file that fails the same way again", async () => {
      const session = owner();
      const f = await importing(session, {
        createdAt: ago(10),
        updatedAt: ago(10),
        dispatchedAt: ago(10),
        deliveryCount: 1,
      });
      await handleWorkerCallback({
        jobId: f.jobId,
        status: "failed",
        error: "too_many_slides",
        errorCode: "too_many_slides",
      } as never);
      const [document] =
        await db()`select status, failure_code from spellbook_documents where id=${f.documentId}`;
      expect(document).toEqual({
        status: "failed",
        failure_code: "too_many_slides",
      });
      await expect(
        retryDocumentProcessing(session, f.documentId),
      ).rejects.toMatchObject({ status: 409 });
    });
  },
);

/** A document open in the browser editor with a history of saves. */
async function editedDocument(session: Session) {
  const documentId = randomUUID();
  const originalId = randomUUID();
  const sessionId = randomUUID();
  const base = prefix(session, documentId);
  const versions: Array<{ id: string; kind: string }> = [];
  await db().begin(async (sql) => {
    await sql`insert into spellbook_documents (id,account_id,file_name,status,original_version_id,current_version_id)
      values (${documentId},${session.accountId},'deck.pptx','ready',${originalId},${originalId})`;
    await sql`insert into spellbook_versions (id,document_id,kind,status,document_object,document_sha256,created_at)
      values (${originalId},${documentId},'original','ready',${`${base}/versions/${originalId}/document.pptx`},${"a".repeat(64)},now()-interval '2 days')`;
    objects.set(
      `${base}/versions/${originalId}/document.pptx`,
      Buffer.alloc(100),
    );
    await sql`insert into spellbook_native_sessions (id,document_id,account_id,account_email,working_version_id,working_sha256,editor_mode,status,expires_at)
      values (${sessionId},${documentId},${session.accountId},${session.email},${originalId},${"a".repeat(64)},'browser','active',now()+interval '1 hour')`;
  });
  let parent = originalId;
  // 30 autosaves, with one AI result and one restore among them.
  for (let index = 0; index < 30; index++) {
    const id = randomUUID();
    const ai = index === 5;
    const restored = index === 6;
    await db().begin(async (sql) => {
      await sql`insert into spellbook_versions (id,document_id,parent_version_id,kind,status,document_object,document_sha256,created_at,restored_from_version_id)
        values (${id},${documentId},${parent},'approved','ready',
          ${restored ? `${base}/versions/${originalId}/document.pptx` : `${base}/versions/${id}/document.pptx`},
          ${"b".repeat(64)},now()-interval '1 day'+${index} * interval '1 minute',${restored ? originalId : null})`;
      await sql`insert into spellbook_jobs (id,job_type,document_id,version_id,status,payload)
        values (${randomUUID()},'scan_render',${documentId},${id},'succeeded',
          ${sql.json({ nativeSessionId: sessionId, changeOrigin: ai ? "ai" : "human", changeTaskIds: ai ? ["task"] : [] })})`;
    });
    if (!restored) {
      objects.set(`${base}/versions/${id}/document.pptx`, Buffer.alloc(10));
      objects.set(
        `${base}/versions/${id}/render/slides/slide-1.png`,
        Buffer.alloc(5),
      );
    }
    versions.push({ id, kind: ai ? "ai" : restored ? "restored" : "autosave" });
    parent = id;
  }
  await db()`update spellbook_documents set current_version_id=${parent} where id=${documentId}`;
  await db()`update spellbook_native_sessions set working_version_id=${parent} where id=${sessionId}`;
  return { documentId, originalId, sessionId, versions, current: parent };
}

describe.skipIf(!enabled)("a stuck save check", () => {
  it("fails the editor session visibly instead of waiting forever", async () => {
    const session = owner();
    const f = await editedDocument(session);
    const versionId = randomUUID();
    const jobId = randomUUID();
    await db().begin(async (sql) => {
      await sql`insert into spellbook_versions (id,document_id,parent_version_id,kind,status,document_object)
        values (${versionId},${f.documentId},${f.current},'approved','processing','saved.pptx')`;
      await sql`insert into spellbook_jobs (id,job_type,document_id,version_id,status,payload,created_at,updated_at,dispatched_at,delivery_count)
        values (${jobId},'scan_render',${f.documentId},${versionId},'queued',
          ${sql.json({ jobId, nativeSessionId: f.sessionId, outputPrefix: "saved/render" })},
          now()-interval '25 minutes',now()-interval '25 minutes',now()-interval '25 minutes',1)`;
      await sql`update spellbook_native_sessions set working_version_id=${versionId},status='validating' where id=${f.sessionId}`;
    });
    await recoverStaleDocumentJobs({
      accountId: session.accountId,
      documentId: f.documentId,
    });
    const [native] =
      await db()`select status,last_error from spellbook_native_sessions where id=${f.sessionId}`;
    expect(native).toEqual({
      status: "failed",
      last_error: "processing_timeout",
    });
    const [document] =
      await db()`select status,current_version_id from spellbook_documents where id=${f.documentId}`;
    // The last checked save stays the document's current version.
    expect(document).toEqual({
      status: "ready",
      current_version_id: f.current,
    });
  });
});

describe.skipIf(!enabled)("bounded storage per document and account", () => {
  it("keeps the newest 20 automatic saves and every original, AI result and restore", async () => {
    const session = owner();
    const f = await editedDocument(session);
    const result = await maintainDocumentStorage(
      session.accountId,
      f.documentId,
    );
    const autosaves = f.versions.filter(
      (version) => version.kind === "autosave",
    );
    // 28 automatic saves; the oldest 8 go.
    expect(result.pruned).toBe(8);
    const remaining = new Set(
      (
        await db()`select id from spellbook_versions where document_id=${f.documentId}`
      ).map((row) => row.id),
    );
    for (const version of autosaves.slice(0, 8))
      expect(remaining.has(version.id)).toBe(false);
    for (const version of autosaves.slice(8))
      expect(remaining.has(version.id)).toBe(true);
    for (const version of f.versions.filter((v) => v.kind !== "autosave"))
      expect(remaining.has(version.id)).toBe(true);
    expect(remaining.has(f.originalId)).toBe(true);
    // Their files are gone; nothing kept points at a removed version.
    const base = prefix(session, f.documentId);
    for (const version of autosaves.slice(0, 8))
      expect(objects.has(`${base}/versions/${version.id}/document.pptx`)).toBe(
        false,
      );
    expect(objects.has(`${base}/versions/${f.originalId}/document.pptx`)).toBe(
      true,
    );
    const dangling = await db()`
      select v.id from spellbook_versions v
      left join spellbook_versions p on p.id=v.parent_version_id
      where v.document_id=${f.documentId} and v.parent_version_id is not null and p.id is null`;
    expect(dangling).toHaveLength(0);
    const [pending] =
      await db()`select count(*)::int as count from spellbook_storage_deletions where document_id=${f.documentId}`;
    expect(pending.count).toBe(0);
    // What the document keeps is measured from storage.
    const [document] =
      await db()`select stored_bytes from spellbook_documents where id=${f.documentId}`;
    expect(Number(document.stored_bytes)).toBe(result.bytes);
    expect(result.bytes).toBe(100 + 21 * 15);
    // A second run has nothing left to remove.
    expect(
      (await maintainDocumentStorage(session.accountId, f.documentId)).pruned,
    ).toBe(0);
  });

  it("counts an account's files and bytes, measuring files not yet measured", async () => {
    const session = owner();
    const f = await editedDocument(session);
    const usage = await accountStorageUsage(session.accountId);
    expect(usage.documents).toBe(1);
    expect(usage.bytes).toBe(100 + 29 * 15);
    const [document] =
      await db()`select stored_bytes_at from spellbook_documents where id=${f.documentId}`;
    expect(document.stored_bytes_at).not.toBeNull();
  });

  it("saves through storage with the same revision and package checks", async () => {
    const session = owner();
    const f = await editedDocument(session);
    // The editor opens at the current version.
    const digest = createHash("sha256")
      .update(Buffer.from("PK-current"))
      .digest("hex");
    await db()`update spellbook_versions set document_sha256=${digest} where id=${f.current}`;
    await db()`update spellbook_native_sessions set working_sha256=${digest} where id=${f.sessionId}`;
    const launch = await createBrowserDocumentLaunch(session, f.documentId);
    const source = await browserDocumentSource(session, f.documentId);
    expect(source.revision).toBe(launch.revision);
    expect(source.url).toContain("https://storage.invalid/read/");

    const request = (body: unknown, headers: Record<string, string> = {}) =>
      new Request(`${origin}/api/documents/${f.documentId}/browser/saves`, {
        method: "POST",
        headers: { origin, "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const candidate = Buffer.from("PK-edited-deck");
    const target = await startBrowserSave(
      session,
      f.documentId,
      request({ size: candidate.length }, { "if-match": launch.revision }),
    );
    if (!target.direct) throw new Error("expected a storage link");
    const written = target.url.replace("https://storage.invalid/write/", "");
    expect(written).toMatch(/\/document\.pptx\.incoming$/);

    // Nothing stored yet: completion refuses.
    await expect(
      completeBrowserSave(
        session,
        f.documentId,
        request({ token: target.token }),
      ),
    ).rejects.toMatchObject({ status: 409, message: "upload_not_found" });
    // A different size than announced is refused and removed.
    objects.set(written, Buffer.from("PK-other-size-deck"));
    await expect(
      completeBrowserSave(
        session,
        f.documentId,
        request({ token: target.token }),
      ),
    ).rejects.toMatchObject({
      status: 400,
      message: "invalid_document_package",
    });
    expect(objects.has(written)).toBe(false);

    objects.set(written, candidate);
    const saved = await completeBrowserSave(
      session,
      f.documentId,
      request({ token: target.token }),
    );
    const savedDigest = createHash("sha256").update(candidate).digest("hex");
    expect(saved.unchanged).toBe(false);
    expect(saved.revision).toMatch(new RegExp(`:${savedDigest}"$`));
    expect(objects.has(written)).toBe(false);
    expect(objects.get(written.replace(/\.incoming$/, ""))).toEqual(candidate);
    expect(workers.enqueueWorkerJob.mock.calls.at(-1)![4]).toEqual({
      lane: "save",
    });
    const [native] =
      await db()`select status, working_sha256 from spellbook_native_sessions where id=${f.sessionId}`;
    expect(native).toEqual({
      status: "validating",
      working_sha256: savedDigest,
    });

    // A token for another document never saves here.
    await expect(
      completeBrowserSave(
        session,
        randomUUID(),
        request({ token: target.token }),
      ),
    ).rejects.toMatchObject({ status: 400, message: "invalid_browser_save" });
  });

  it("refuses a new save over the free plan but keeps unchanged saves working", async () => {
    const session = owner();
    const f = await editedDocument(session);
    const digest = createHash("sha256")
      .update(Buffer.from("PK-current"))
      .digest("hex");
    await db()`update spellbook_versions set document_sha256=${digest} where id=${f.current}`;
    await db()`update spellbook_native_sessions set working_sha256=${digest} where id=${f.sessionId}`;
    await db()`update spellbook_documents set stored_bytes=${1024 * 1024 * 1024}, stored_bytes_at=now() where id=${f.documentId}`;
    const launch = await createBrowserDocumentLaunch(session, f.documentId);
    const request = (body: unknown, headers: Record<string, string> = {}) =>
      new Request(`${origin}/api/documents/${f.documentId}/browser/saves`, {
        method: "POST",
        headers: { origin, "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const save = async (bytes: Buffer) => {
      const target = await startBrowserSave(
        session,
        f.documentId,
        request({ size: bytes.length }, { "if-match": launch.revision }),
      );
      if (!target.direct) throw new Error("expected a storage link");
      const written = target.url.replace("https://storage.invalid/write/", "");
      objects.set(written, bytes);
      return {
        written,
        result: completeBrowserSave(
          session,
          f.documentId,
          request({ token: target.token }),
        ),
      };
    };
    const changed = await save(Buffer.from("PK-new-content"));
    await expect(changed.result).rejects.toMatchObject({
      status: 403,
      message: "storage_full",
    });
    expect(objects.has(changed.written)).toBe(false);
    const unchanged = await save(Buffer.from("PK-current"));
    await expect(unchanged.result).resolves.toEqual({
      revision: launch.revision,
      unchanged: true,
    });
  });
});
