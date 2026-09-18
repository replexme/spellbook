import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Session } from "./models";

const workers = vi.hoisted(() => ({
  enqueueWorkerJob: vi.fn(),
  callAiAccount: vi.fn(async () => ({ models: [] })),
}));
const storage = vi.hoisted(() => ({
  getObject: vi.fn(async () => Buffer.from("PK-test-pptx")),
  getJsonObject: vi.fn(async (objectName: string) =>
    objectName.includes("validation")
      ? {
          valid: true,
          candidateDocumentSha256: "b".repeat(64),
        }
      : {
          documentSha256: "b".repeat(64),
          slides: [{ previewObject: "native/slide-1.png" }],
        },
  ),
  putObject: vi.fn(),
  deleteObject: vi.fn(async () => {}),
}));
vi.mock("./workers", () => workers);
vi.mock("./storage", () => ({
  ...storage,
  storageNamespace: () => "integration-storageNamespace",
  accountPrefix: (account: string, document: string) =>
    `accounts/${Buffer.from(account).toString("base64url")}/documents/${document}`,
}));
vi.mock("./db", async (original) => ({
  ...(await original<typeof import("./db")>()),
  ensureSchema: async () => {},
}));

import { db } from "./db";
import {
  createBrowserDocumentLaunch,
  getBrowserDocument,
  saveBrowserDocument,
} from "./browser-session";
import {
  cancelNativeTurn,
  completeNativeScan,
  completeNativeTask,
  completeNativeTurn,
  executeNativeTool,
  failNativeScan,
  markNativeUndo,
  pollNativeSession,
  submitNativeTurn,
} from "./native-runtime";
import { listNativeTurns, listVersions, restoreVersion } from "./document-history";
import { signWopiToken } from "./wopi-token";
import {
  createNativeLaunch,
  wopiGetFile,
  wopiLock,
  wopiPutFile,
} from "./native-session";
import { requireNativeRequestSession } from "./native-request-auth";
import { authorizeNativeConnectorJob } from "./native-connector-auth";
import { getImageAsset } from "./image-assets";
import { POST as postNativeConnectorTool } from "../app/api/native/jobs/[jobId]/tools/route";
import { POST as postNativeConnectorCallback } from "../app/api/native/jobs/[jobId]/callback/route";

const enabled = process.env.SPELLBOOK_NATIVE_INTEGRATION === "1";
const schema = `spellbook_native_${randomUUID().replaceAll("-", "")}`;
const accountId = `native-owner-${randomUUID()}`;
const session: Session = {
  accountId,
  email: "owner@example.test",
  admin: true,
  token: "integration",
};

beforeAll(async () => {
  if (!enabled) return;
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://spellbook.integration.invalid");
  vi.stubEnv(
    "SPELLBOOK_BROWSER_OFFICE_URL",
    "https://office.spellbook.integration.invalid",
  );
  vi.stubEnv(
    "SPELLBOOK_WOPI_SECRET",
    "integration-wopi-secret-that-is-long-enough",
  );
  vi.stubEnv("SPELLBOOK_INTERNAL_TOKEN", "integration-internal-token");
  await db().unsafe(
    `create schema "${schema}"; set search_path to "${schema}"`,
  );
  const actual = await vi.importActual<typeof import("./db")>("./db");
  await actual.ensureSchema();
});
afterAll(async () => {
  if (!enabled) return;
  await db().unsafe(`drop schema if exists "${schema}" cascade`);
  await db().end();
  vi.unstubAllEnvs();
});

async function fixture() {
  const documentId = randomUUID();
  const versionId = randomUUID();
  const nativeSessionId = randomUUID();
  const graphObject = `accounts/${Buffer.from(accountId).toString("base64url")}/documents/${documentId}/versions/${versionId}/render/element-graph.json`;
  await db().begin(async (sql) => {
    await sql`insert into spellbook_documents (id,account_id,file_name,status,original_version_id,current_version_id)
      values (${documentId},${accountId},'native.pptx','ready',${versionId},${versionId})`;
    await sql`insert into spellbook_versions (id,document_id,kind,status,document_object,graph_object,document_sha256,slide_count)
      values (${versionId},${documentId},'original','ready','native/document.pptx',${graphObject},${"a".repeat(64)},1)`;
    await sql`insert into spellbook_native_sessions (id,document_id,account_id,account_email,working_version_id,working_sha256,status,expires_at)
      values (${nativeSessionId},${documentId},${accountId},${session.email},${versionId},${"a".repeat(64)},'active',now()+interval '1 hour')`;
  });
  return { documentId, versionId, nativeSessionId };
}

async function addPastNativeTurn(
  context: Awaited<ReturnType<typeof fixture>>,
  input: {
    request: string;
    response: string | null;
    status: "completed" | "failed" | "cancelled";
    createdAt: Date;
  },
) {
  const turnId = randomUUID();
  const jobId = randomUUID();
  await db().begin(async (sql) => {
    await sql`insert into spellbook_jobs
      (id,job_type,document_id,version_id,status,payload,created_at)
      values (${jobId},'native_turn',${context.documentId},${context.versionId},'succeeded',${sql.json({ historical: true })},${input.createdAt})`;
    await sql`insert into spellbook_native_turns
      (id,session_id,document_id,account_id,job_id,request_text,permission_mode,status,assistant_text,created_at)
      values (${turnId},${context.nativeSessionId},${context.documentId},${accountId},${jobId},${input.request},'document',${input.status},${input.response},${input.createdAt})`;
  });
}

const observation = {
  unit: "1/100mm",
  activeSlide: 0,
  selectedElementIds: ["0/0"],
  slides: [{ slideIndex: 0, elements: [{ elementId: "0/0", text: "현재" }] }],
  images: [{ slideIndex: 0, pngBytes: [137, 80, 78, 71, 13, 10, 26, 10] }],
  changedSlideIndexes: [],
  visualEvidenceComplete: true,
};

describe.skipIf(!enabled)("durable native editor orchestration", () => {
  it("keeps document-scoped editor requests alive without the broader login cookie", async () => {
    const f = await fixture();
    const token = signWopiToken({
      version: 1,
      sessionId: f.nativeSessionId,
      documentId: f.documentId,
      accountId,
      expiresAt: Date.now() + 60_000,
    });
    const authenticated = await requireNativeRequestSession(
      new Request(`https://spellbook.integration.invalid/native`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      f.documentId,
    );
    expect(authenticated).toMatchObject({
      accountId,
      email: session.email,
      admin: true,
    });
    await expect(
      requireNativeRequestSession(
        new Request(`https://spellbook.integration.invalid/native`, {
          headers: { authorization: `Bearer ${token}x` },
        }),
        f.documentId,
      ),
    ).rejects.toMatchObject({
      status: 401,
      message: "invalid_native_capability",
    });
  });

  it("distinguishes document processing from a permanent import failure", async () => {
    const processing = await fixture();
    await db()`update spellbook_documents set status='processing' where id=${processing.documentId}`;
    await expect(
      createNativeLaunch(session, processing.documentId),
    ).rejects.toMatchObject({ status: 409, message: "document_processing" });

    const failed = await fixture();
    await db().begin(async (sql) => {
      await sql`update spellbook_documents set status='failed',last_error='broken package' where id=${failed.documentId}`;
      await sql`update spellbook_versions set status='failed' where id=${failed.versionId}`;
    });
    await expect(
      createNativeLaunch(session, failed.documentId),
    ).rejects.toMatchObject({
      status: 422,
      message: "document_processing_failed",
    });
  });

  it("orders event cursors numerically after the identifier gains a digit", async () => {
    const f = await fixture();
    await db()`insert into spellbook_native_events (id,session_id,event_type,payload)
      values
        (900000000,${f.nativeSessionId},'tool',${db().json({ label: "before boundary" })}),
        (1000000000,${f.nativeSessionId},'tool',${db().json({ label: "after boundary" })})`;

    const polled = await pollNativeSession(session, f.documentId, 0);

    expect(polled.events.map((event) => event.id)).toEqual([
      900000000, 1000000000,
    ]);
  });

  it("enforces a WOPI lock and versions a save without overwriting the original", async () => {
    const f = await fixture();
    const token = signWopiToken({
      version: 1,
      sessionId: f.nativeSessionId,
      documentId: f.documentId,
      accountId,
      expiresAt: Date.now() + 60_000,
    });
    const url = `https://spellbook.integration.invalid/api/wopi/files/${f.documentId}?access_token=${encodeURIComponent(token)}`;
    expect(
      await wopiLock(
        new Request(url, {
          method: "POST",
          headers: {
            "x-wopi-override": "LOCK",
            "x-wopi-lock": "editor-lock",
            "x-wopi-lockexpirationtimeout": "90",
          },
        }),
        f.documentId,
      ),
    ).toEqual({ status: 200 });
    const [locked] = await db()`
      select wopi_lock,
        extract(epoch from (lock_expires_at-lock_updated_at)) as lock_seconds
      from spellbook_native_sessions where id=${f.nativeSessionId}
    `;
    expect(locked.wopi_lock).toBe("editor-lock");
    expect(Number(locked.lock_seconds)).toBeCloseTo(90, 3);
    expect(
      await wopiLock(
        new Request(url, {
          method: "POST",
          headers: { "x-wopi-override": "LOCK", "x-wopi-lock": "other-lock" },
        }),
        f.documentId,
      ),
    ).toEqual({ status: 409, lock: "editor-lock" });
    const savedBytes = Buffer.from("PK-new-native-document");
    const contentsUrl = new URL(url);
    contentsUrl.pathname += "/contents";
    await wopiPutFile(
      new Request(contentsUrl, {
        method: "POST",
        headers: { "x-wopi-lock": "editor-lock" },
        body: savedBytes,
      }),
      f.documentId,
    );
    expect(workers.enqueueWorkerJob.mock.calls.at(-1)?.[3]).toEqual(
      expect.objectContaining({
        inputObject: expect.stringContaining(
          `/documents/${f.documentId}/versions/`,
        ),
        baselineInputObject: "native/document.pptx",
        nativeSessionId: f.nativeSessionId,
        changeOrigin: "human",
        changeBudget: expect.objectContaining({
          allowPartCreationOrDeletion: true,
          targetSlideIndexes: null,
        }),
      }),
    );
    expect(storage.putObject).toHaveBeenCalledWith(
      expect.stringContaining(`/documents/${f.documentId}/versions/`),
      savedBytes,
      expect.stringContaining("presentationml"),
    );
    const [document] =
      await db()`select current_version_id from spellbook_documents where id=${f.documentId}`;
    const [native] =
      await db()`select working_version_id,status from spellbook_native_sessions where id=${f.nativeSessionId}`;
    expect(document.current_version_id).toBe(f.versionId);
    expect(native).toMatchObject({ status: "validating" });
    expect(native.working_version_id).not.toBe(f.versionId);
  });

  it("implements WOPI lock transitions, expiry, and extended lock limits", async () => {
    const f = await fixture();
    const token = signWopiToken({
      version: 1,
      sessionId: f.nativeSessionId,
      documentId: f.documentId,
      accountId,
      expiresAt: Date.now() + 60_000,
    });
    const url = `https://spellbook.integration.invalid/api/wopi/files/${f.documentId}?access_token=${encodeURIComponent(token)}`;
    const lock = (
      operation: "LOCK" | "REFRESH_LOCK" | "UNLOCK" | "GET_LOCK",
      value?: string,
      extra: Record<string, string> = {},
    ) =>
      wopiLock(
        new Request(url, {
          method: "POST",
          headers: {
            "x-wopi-override": operation,
            ...(value === undefined ? {} : { "x-wopi-lock": value }),
            ...extra,
          },
        }),
        f.documentId,
      );

    await expect(lock("GET_LOCK")).resolves.toEqual({ status: 200, lock: "" });
    await expect(lock("REFRESH_LOCK", "missing")).resolves.toEqual({
      status: 409,
      lock: "",
    });
    await expect(lock("LOCK", "x".repeat(1025))).rejects.toMatchObject({
      status: 400,
      message: "invalid_wopi_lock",
    });
    await expect(lock("LOCK", "é")).rejects.toMatchObject({
      status: 400,
      message: "invalid_wopi_lock",
    });
    await expect(
      lock("LOCK", "first", { "x-wopi-lockexpirationtimeout": "59" }),
    ).rejects.toMatchObject({
      status: 400,
      message: "invalid_wopi_lock_timeout",
    });
    await expect(lock("LOCK", "first")).resolves.toEqual({ status: 200 });
    let [lifetime] = await db()`
      select extract(epoch from (lock_expires_at-lock_updated_at)) as seconds
      from spellbook_native_sessions where id=${f.nativeSessionId}
    `;
    expect(Number(lifetime.seconds)).toBeCloseTo(30 * 60, 3);
    await expect(
      lock("REFRESH_LOCK", "first", {
        "x-wopi-lockexpirationtimeout": "120",
      }),
    ).resolves.toEqual({ status: 200 });
    [lifetime] = await db()`
      select extract(epoch from (lock_expires_at-lock_updated_at)) as seconds
      from spellbook_native_sessions where id=${f.nativeSessionId}
    `;
    expect(Number(lifetime.seconds)).toBeCloseTo(120, 3);
    await expect(
      lock("LOCK", "second", { "x-wopi-oldlock": "first" }),
    ).resolves.toEqual({ status: 200 });
    await expect(lock("GET_LOCK")).resolves.toEqual({
      status: 200,
      lock: "second",
    });
    await db()`
      update spellbook_native_sessions set lock_expires_at=now()-interval '1 second'
      where id=${f.nativeSessionId}
    `;
    await expect(lock("GET_LOCK")).resolves.toEqual({ status: 200, lock: "" });
    const contentsUrl = new URL(url);
    contentsUrl.pathname += "/contents";
    await expect(
      wopiPutFile(
        new Request(contentsUrl, {
          method: "POST",
          headers: { "x-wopi-lock": "second" },
          body: Buffer.from("PK-stale-lock-save"),
        }),
        f.documentId,
      ),
    ).rejects.toMatchObject({ message: "wopi_lock_mismatch", lock: "" });
    const [expired] = await db()`
      select wopi_lock,lock_updated_at,lock_expires_at
      from spellbook_native_sessions where id=${f.nativeSessionId}
    `;
    expect(expired).toMatchObject({
      wopi_lock: null,
      lock_updated_at: null,
      lock_expires_at: null,
    });
  });

  it("derives a slide-scoped package budget from the reviewed AI commands", async () => {
    const f = await fixture();
    const submitted = await submitNativeTurn(session, f.documentId, {
      text: "첫 슬라이드 제목을 바꿔줘",
      permission: "document",
    });
    const [turn] = await db()`
      select job_id from spellbook_native_turns where id=${submitted.turnId}
    `;
    const owner = {
      jobId: String(turn.job_id),
      sessionId: f.nativeSessionId,
      executionToken: "budget-worker",
    };
    await executeNativeTool({ ...owner, operation: "start" });
    const task = (await executeNativeTool({
      ...owner,
      operation: "task_create",
      request: {
        operation: "edit",
        command: { op: "replace_text", elementId: "0/0", text: "변경" },
      },
    })) as { taskId: string };
    await completeNativeTask(session, f.documentId, {
      id: task.taskId,
      value: { ...observation, changedSlideIndexes: [0] },
    });
    await completeNativeTurn(
      { id: owner.jobId },
      {
        jobId: owner.jobId,
        status: "succeeded",
        result: {
          text: "화면까지 확인해 제목을 바꿨습니다.",
          changed: true,
          reviewed: true,
          executionToken: owner.executionToken,
        },
      },
    );

    const token = signWopiToken({
      version: 1,
      sessionId: f.nativeSessionId,
      documentId: f.documentId,
      accountId,
      expiresAt: Date.now() + 60_000,
    });
    const url = `https://spellbook.integration.invalid/api/wopi/files/${f.documentId}?access_token=${encodeURIComponent(token)}`;
    await wopiLock(
      new Request(url, {
        method: "POST",
        headers: { "x-wopi-override": "LOCK", "x-wopi-lock": "ai-save" },
      }),
      f.documentId,
    );
    const contentsUrl = new URL(url);
    contentsUrl.pathname += "/contents";
    await wopiPutFile(
      new Request(contentsUrl, {
        method: "POST",
        headers: { "x-wopi-lock": "ai-save" },
        body: Buffer.from("PK-reviewed-ai-save"),
      }),
      f.documentId,
    );

    expect(workers.enqueueWorkerJob.mock.calls.at(-1)?.[3]).toMatchObject({
      changeOrigin: "ai",
      changeTaskIds: [task.taskId],
      changeBudget: {
        allowedCategories: ["slide_parts"],
        targetSlideIndexes: [0],
        allowPartCreationOrDeletion: false,
      },
    });
  });

  it("refuses to save an AI mutation before its visual review completes", async () => {
    const f = await fixture();
    const submitted = await submitNativeTurn(session, f.documentId, {
      text: "첫 슬라이드 제목을 바꿔줘",
      permission: "document",
    });
    const [turn] = await db()`
      select job_id from spellbook_native_turns where id=${submitted.turnId}
    `;
    const owner = {
      jobId: String(turn.job_id),
      sessionId: f.nativeSessionId,
      executionToken: "pending-review-worker",
    };
    await executeNativeTool({ ...owner, operation: "start" });
    const task = (await executeNativeTool({
      ...owner,
      operation: "task_create",
      request: {
        operation: "edit",
        command: { op: "replace_text", elementId: "0/0", text: "변경" },
      },
    })) as { taskId: string };
    await completeNativeTask(session, f.documentId, {
      id: task.taskId,
      value: { ...observation, changedSlideIndexes: [0] },
    });

    const token = signWopiToken({
      version: 1,
      sessionId: f.nativeSessionId,
      documentId: f.documentId,
      accountId,
      expiresAt: Date.now() + 60_000,
    });
    const url = `https://spellbook.integration.invalid/api/wopi/files/${f.documentId}?access_token=${encodeURIComponent(token)}`;
    await wopiLock(
      new Request(url, {
        method: "POST",
        headers: { "x-wopi-override": "LOCK", "x-wopi-lock": "review-pending" },
      }),
      f.documentId,
    );
    const contentsUrl = new URL(url);
    contentsUrl.pathname += "/contents";
    const unchangedBytes = Buffer.from("PK-unchanged-before-ai-review");
    const unchangedDigest = createHash("sha256")
      .update(unchangedBytes)
      .digest("hex");
    await db()`
      update spellbook_native_sessions set working_sha256=${unchangedDigest}
      where id=${f.nativeSessionId}
    `;
    const unchanged = await wopiPutFile(
      new Request(contentsUrl, {
        method: "POST",
        headers: { "x-wopi-lock": "review-pending" },
        body: unchangedBytes,
      }),
      f.documentId,
    );
    expect(unchanged.unchanged).toBe(true);
    const [beforeSave] = await db()`
      select save_revision from spellbook_native_sessions where id=${f.nativeSessionId}
    `;
    expect(beforeSave.save_revision).toBe(0);
    const put = () =>
      wopiPutFile(
        new Request(contentsUrl, {
          method: "POST",
          headers: { "x-wopi-lock": "review-pending" },
          body: Buffer.from("PK-unreviewed-ai-save"),
        }),
        f.documentId,
      );
    const dispatchCount = workers.enqueueWorkerJob.mock.calls.length;
    await expect(put()).rejects.toThrow("native_ai_change_review_pending");
    expect(workers.enqueueWorkerJob.mock.calls).toHaveLength(dispatchCount);
    const [versions] = await db()`
      select count(*)::int as count from spellbook_versions where document_id=${f.documentId}
    `;
    expect(versions.count).toBe(1);

    await completeNativeTurn(
      { id: owner.jobId },
      {
        jobId: owner.jobId,
        status: "succeeded",
        result: {
          text: "화면까지 확인해 제목을 바꿨습니다.",
          changed: true,
          reviewed: true,
          executionToken: owner.executionToken,
        },
      },
    );
    await put();
    expect(workers.enqueueWorkerJob.mock.calls.at(-1)?.[3]).toMatchObject({
      changeOrigin: "ai",
      changeTaskIds: [task.taskId],
      changeBudget: { targetSlideIndexes: [0] },
    });
  });

  it("keeps a no-op browser save on the same evidence revision", async () => {
    const f = await fixture();
    const unchangedBytes = Buffer.from("PK-test-pptx");
    const digest = createHash("sha256").update(unchangedBytes).digest("hex");
    await db().begin(async (sql) => {
      await sql`
        update spellbook_versions set document_sha256=${digest}
        where id=${f.versionId}
      `;
      await sql`
        update spellbook_native_sessions set working_sha256=${digest}
        where id=${f.nativeSessionId}
      `;
    });
    const launch = await createBrowserDocumentLaunch(session, f.documentId);
    const saved = await saveBrowserDocument(
      session,
      f.documentId,
      new Request(
        `https://spellbook.integration.invalid/api/documents/${f.documentId}/browser/contents`,
        {
          method: "PUT",
          headers: {
            origin: "https://spellbook.integration.invalid",
            "if-match": launch.revision,
          },
          body: unchangedBytes,
        },
      ),
    );
    expect(saved).toEqual({ revision: launch.revision, unchanged: true });
    const [native] = await db()`
      select save_revision,status from spellbook_native_sessions where id=${f.nativeSessionId}
    `;
    expect(native).toMatchObject({ save_revision: 0, status: "active" });
  });

  it("reconciles a browser candidate only against its exact owned revision", async () => {
    const f = await fixture();
    const launch = await createBrowserDocumentLaunch(session, f.documentId);
    expect(launch).toMatchObject({
      documentId: f.documentId,
      fileName: "native.pptx",
      revision: `"${f.versionId}:${"a".repeat(64)}"`,
    });
    const opened = await getBrowserDocument(session, f.documentId);
    expect(opened.data).toEqual(Buffer.from("PK-test-pptx"));
    expect(opened.revision).toBe(launch.revision);

    const candidate = Buffer.from("PK-browser-candidate");
    const request = (
      revision: string,
      origin = "https://spellbook.integration.invalid",
    ) =>
      new Request(
        `https://spellbook.integration.invalid/api/documents/${f.documentId}/browser/contents`,
        {
          method: "PUT",
          headers: { origin, "if-match": revision },
          body: candidate,
        },
      );
    await expect(
      saveBrowserDocument(
        session,
        f.documentId,
        request(launch.revision, "https://attacker.invalid"),
      ),
    ).rejects.toMatchObject({ status: 403, message: "invalid_browser_origin" });
    await expect(
      saveBrowserDocument(
        session,
        f.documentId,
        request(`"${randomUUID()}:${"b".repeat(64)}"`),
      ),
    ).rejects.toMatchObject({
      status: 412,
      message: "browser_revision_changed",
    });

    const saved = await saveBrowserDocument(
      session,
      f.documentId,
      request(launch.revision),
    );
    expect(saved.unchanged).toBe(false);
    expect(saved.revision).not.toBe(launch.revision);
    expect(workers.enqueueWorkerJob.mock.calls.at(-1)?.[3]).toEqual(
      expect.objectContaining({
        inputObject: expect.stringContaining(
          `/documents/${f.documentId}/versions/`,
        ),
        baselineInputObject: "native/document.pptx",
        nativeSessionId: f.nativeSessionId,
        changeOrigin: "human",
      }),
    );
    const [native] = await db()`
      select editor_mode,status,working_version_id from spellbook_native_sessions
      where id=${f.nativeSessionId}
    `;
    expect(native).toMatchObject({
      editor_mode: "browser",
      status: "validating",
    });
    expect(native.working_version_id).not.toBe(f.versionId);

    const token = signWopiToken({
      version: 1,
      sessionId: f.nativeSessionId,
      documentId: f.documentId,
      accountId,
      expiresAt: Date.now() + 60_000,
    });
    await expect(
      wopiGetFile(
        new Request(
          `https://spellbook.integration.invalid/api/wopi/files/${f.documentId}?access_token=${encodeURIComponent(token)}`,
        ),
        f.documentId,
      ),
    ).rejects.toMatchObject({ status: 401, message: "expired_wopi_session" });
  });

  it("does not switch to browser editing while Collabora owns the WOPI lock", async () => {
    const f = await fixture();
    await db()`update spellbook_native_sessions set wopi_lock='editor-lock' where id=${f.nativeSessionId}`;
    await expect(
      createBrowserDocumentLaunch(session, f.documentId),
    ).rejects.toMatchObject({
      status: 409,
      message: "office_editor_save_required",
    });
  });

  it("expires an abandoned WOPI lock before switching editor modes", async () => {
    const f = await fixture();
    await db()`
      update spellbook_native_sessions set
        wopi_lock='abandoned-lock',lock_updated_at=now()-interval '31 minutes',
        lock_expires_at=null
      where id=${f.nativeSessionId}
    `;
    await expect(
      createBrowserDocumentLaunch(session, f.documentId),
    ).resolves.toMatchObject({ documentId: f.documentId });
    const [native] = await db()`
      select editor_mode,wopi_lock,lock_expires_at
      from spellbook_native_sessions where id=${f.nativeSessionId}
    `;
    expect(native).toMatchObject({
      editor_mode: "browser",
      wopi_lock: null,
      lock_expires_at: null,
    });
  });

  it("leases one AI turn, redelivers a browser task safely, and records completion", async () => {
    const f = await fixture();
    const submitted = await submitNativeTurn(session, f.documentId, {
      text: "제목 변경",
      permission: "selection",
    });
    expect(workers.enqueueWorkerJob).toHaveBeenCalledWith(
      expect.any(String),
      "ai",
      "/internal/jobs/native",
      expect.objectContaining({ sessionId: f.nativeSessionId }),
    );
    const [turn] =
      await db()`select * from spellbook_native_turns where id=${submitted.turnId}`;
    const owner = {
      jobId: turn.job_id,
      sessionId: f.nativeSessionId,
      executionToken: "worker-1",
    };
    await executeNativeTool({ ...owner, operation: "start" });
    await expect(
      executeNativeTool({
        ...owner,
        executionToken: "worker-2",
        operation: "task_create",
        request: { operation: "observe" },
      }),
    ).rejects.toThrow("lease_lost");
    const created = (await executeNativeTool({
      ...owner,
      operation: "task_create",
      request: { operation: "observe" },
    })) as { taskId: string };
    const polled = await pollNativeSession(session, f.documentId, 0);
    expect(polled.task).toMatchObject({
      id: created.taskId,
      request: { operation: "observe" },
    });
    await completeNativeTask(session, f.documentId, {
      id: created.taskId,
      value: observation,
    });
    expect(
      await executeNativeTool({
        ...owner,
        operation: "task_status",
        taskId: created.taskId,
      }),
    ).toMatchObject({ status: "completed", result: observation });
    await executeNativeTool({
      ...owner,
      operation: "event",
      type: "tool",
      value: "슬라이드 수정",
    });
    const callback = {
      jobId: turn.job_id,
      status: "succeeded" as const,
      mode: "native" as const,
      result: {
        text: "수정했습니다.",
        changed: true,
        reviewed: true,
        status: "completed",
        executionToken: "worker-1",
      },
    };
    await completeNativeTurn({ id: turn.job_id }, callback);
    await completeNativeTurn({ id: turn.job_id }, callback);
    const final = await pollNativeSession(session, f.documentId, 0);
    expect(final.events.filter((event) => event.type === "done")).toHaveLength(
      1,
    );
  });

  it("keeps AI screenshots only while a request runs and names the save after an undo", async () => {
    const f = await fixture();
    const submitted = await submitNativeTurn(session, f.documentId, {
      text: "제목 바꿔 줘",
      permission: "slides",
    });
    const [turn] = await db()`select * from spellbook_native_turns where id=${submitted.turnId}`;
    const owner = { jobId: turn.job_id, sessionId: f.nativeSessionId, executionToken: "worker-undo" };
    await executeNativeTool({ ...owner, operation: "start" });
    const observed = (await executeNativeTool({
      ...owner,
      operation: "task_create",
      request: { operation: "observe" },
    })) as { taskId: string };
    await pollNativeSession(session, f.documentId, 0);
    await completeNativeTask(session, f.documentId, {
      id: observed.taskId,
      value: { ...observation, revision: "before", engine: { patchLevel: "stock", supportedOperations: [] } },
    });
    const edited = (await executeNativeTool({
      ...owner,
      operation: "task_create",
      request: { operation: "edit_batch", commands: [{ op: "replace_text", elementId: "0/0" }] },
    })) as { taskId: string };
    await pollNativeSession(session, f.documentId, 0);
    await completeNativeTask(session, f.documentId, {
      id: edited.taskId,
      value: {
        ...observation,
        revision: "after",
        slides: [{ slideIndex: 0, elements: [{ elementId: "0/0", text: "바뀜" }] }],
        changedSlideIndexes: [0],
        transaction: { status: "applied", undoActionsAdded: 1 },
        layoutAudit: { introducedIssueCount: 0, introducedIssues: [] },
      },
    });
    // While the request runs the AI can read the screenshot.
    expect(
      await executeNativeTool({ ...owner, operation: "task_status", taskId: edited.taskId }),
    ).toMatchObject({ result: { images: [expect.any(Object)] } });
    await completeNativeTurn(
      { id: turn.job_id },
      {
        jobId: turn.job_id,
        status: "succeeded",
        mode: "native",
        result: { text: "바꿨어요.", changed: true, reviewed: true, status: "completed", executionToken: "worker-undo" },
      },
    );
    const tasks = await db()`select result from spellbook_native_tasks where turn_id=${submitted.turnId}`;
    expect(tasks.every((task) => task.result && !("images" in task.result))).toBe(true);
    const [stored] = await db()`select summary from spellbook_native_turns where id=${submitted.turnId}`;
    expect(stored.summary).toMatchObject({
      outcome: "changed",
      undoSteps: 1,
      revisions: { before: "before", after: "after" },
      evidence: [{ slideIndex: 0, before: `${observed.taskId}:0`, after: `${edited.taskId}:0` }],
    });
    const [engine] = await db()`select patch_level from spellbook_editor_engines where editor_mode='wopi'`;
    expect(engine.patch_level).toBe("stock");

    // Undo is recorded once and names the next save.
    const marked = await markNativeUndo(session, f.documentId, submitted.turnId);
    expect(marked.turnId).toBe(submitted.turnId);
    expect((await markNativeUndo(session, f.documentId, submitted.turnId)).undoneAt).toBe(marked.undoneAt);
    const events = await pollNativeSession(session, f.documentId, 0);
    expect(events.events.filter((event) => event.type === "undone")).toHaveLength(1);
    expect((await listNativeTurns(session, f.documentId)).at(-1)?.undoneAt).toBe(marked.undoneAt);
    const token = signWopiToken({
      version: 1,
      sessionId: f.nativeSessionId,
      documentId: f.documentId,
      accountId,
      expiresAt: Date.now() + 60_000,
    });
    const url = `https://spellbook.integration.invalid/api/wopi/files/${f.documentId}?access_token=${encodeURIComponent(token)}`;
    await wopiLock(
      new Request(url, { method: "POST", headers: { "x-wopi-override": "LOCK", "x-wopi-lock": "undo-lock" } }),
      f.documentId,
    );
    const contentsUrl = new URL(url);
    contentsUrl.pathname += "/contents";
    const bytes = Buffer.from("PK-undone-document");
    await wopiPutFile(
      new Request(contentsUrl, { method: "POST", headers: { "x-wopi-lock": "undo-lock" }, body: bytes }),
      f.documentId,
    );
    const [saved] = await db()`
      select v.undone_turn_id, v.document_bytes, s.pending_undo_turn_id
      from spellbook_native_sessions s join spellbook_versions v on v.id=s.working_version_id
      where s.id=${f.nativeSessionId}
    `;
    expect(saved).toMatchObject({ undone_turn_id: submitted.turnId, pending_undo_turn_id: null });
    expect(Number(saved.document_bytes)).toBe(bytes.length);
  });

  it("undoes only the latest request of the session", async () => {
    const f = await fixture();
    await addPastNativeTurn(f, { request: "먼저", response: "했어요", status: "completed", createdAt: new Date(Date.now() - 60_000) });
    await addPastNativeTurn(f, { request: "나중", response: "했어요", status: "completed", createdAt: new Date() });
    const turns = await db()`select id from spellbook_native_turns where session_id=${f.nativeSessionId} order by created_at`;
    await expect(markNativeUndo(session, f.documentId, turns[0]!.id)).rejects.toThrow("undo_not_latest_request");
    await expect(markNativeUndo(session, f.documentId, turns[1]!.id)).rejects.toThrow("undo_nothing_changed");
  });

  it("restores a version as a new version with the same file and SHA-256", async () => {
    const f = await fixture();
    const restored = await restoreVersion(session, f.documentId, f.versionId);
    const [source] = await db()`select document_object, document_sha256 from spellbook_versions where id=${f.versionId}`;
    const [copy] = await db()`select document_object, document_sha256, restored_from_version_id from spellbook_versions where id=${restored.versionId}`;
    expect(copy).toMatchObject({
      document_object: source.document_object,
      document_sha256: source.document_sha256,
      restored_from_version_id: f.versionId,
    });
    const { versions } = await listVersions(session, f.documentId);
    expect(versions.map((version) => version.id)).toEqual(expect.arrayContaining([f.versionId, restored.versionId]));
  });

  it("hands a local subscription turn to the connector with only a job-scoped capability", async () => {
    const previousMode = process.env.SPELLBOOK_AI_CONNECTOR_MODE;
    process.env.SPELLBOOK_AI_CONNECTOR_MODE = "local";
    workers.enqueueWorkerJob.mockClear();
    try {
      const f = await fixture();
      const submitted = await submitNativeTurn(session, f.documentId, {
        text: "선택한 제목을 고쳐줘",
        permission: "selection",
        execution: "local",
      });
      expect(workers.enqueueWorkerJob).not.toHaveBeenCalled();
      expect(submitted.localJob).toMatchObject({
        mode: "native",
        sessionId: f.nativeSessionId,
        requestText: "선택한 제목을 고쳐줘",
        execution: "local",
      });
      expect(submitted.localJob?.capability).not.toBe(
        process.env.SPELLBOOK_INTERNAL_TOKEN,
      );
      expect(submitted.localJob?.toolUrl).toBe(
        `https://spellbook.integration.invalid/api/native/jobs/${submitted.localJob?.jobId}/tools`,
      );

      const polled = await pollNativeSession(session, f.documentId, 0);
      expect(workers.enqueueWorkerJob).not.toHaveBeenCalled();
      expect(polled.localJob).toMatchObject({
        jobId: submitted.localJob?.jobId,
        sessionId: f.nativeSessionId,
      });

      const jobId = String(submitted.localJob?.jobId);
      const authorized = await authorizeNativeConnectorJob(
        new Request(
          `https://spellbook.integration.invalid/api/native/jobs/${jobId}/tools`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${submitted.localJob?.capability}`,
            },
          },
        ),
        jobId,
      );
      expect(authorized.id).toBe(jobId);
      await expect(
        authorizeNativeConnectorJob(
          new Request(
            `https://spellbook.integration.invalid/api/native/jobs/${jobId}/tools`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${submitted.localJob?.capability}x`,
              },
            },
          ),
          jobId,
        ),
      ).rejects.toMatchObject({
        status: 401,
        message: "invalid_native_connector_capability",
      });

      const executionToken = "local-connector-execution";
      const toolResponse = await postNativeConnectorTool(
        new Request(
          `https://spellbook.integration.invalid/api/native/jobs/${jobId}/tools`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${submitted.localJob?.capability}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              jobId,
              sessionId: f.nativeSessionId,
              executionToken,
              operation: "start",
            }),
          },
        ),
        { params: Promise.resolve({ jobId }) },
      );
      expect(toolResponse.status).toBe(200);
      await expect(
        executeNativeTool({
          jobId,
          sessionId: f.nativeSessionId,
          executionToken,
          operation: "heartbeat",
        }),
      ).resolves.toEqual({ accepted: true });

      const callbackResponse = await postNativeConnectorCallback(
        new Request(
          `https://spellbook.integration.invalid/api/native/jobs/${jobId}/callback`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${submitted.localJob?.capability}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              jobId,
              status: "succeeded",
              mode: "native",
              result: {
                text: "로컬 구독으로 수정했습니다.",
                changed: true,
                reviewed: true,
                status: "completed",
                executionToken,
              },
            }),
          },
        ),
        { params: Promise.resolve({ jobId }) },
      );
      expect(callbackResponse.status).toBe(200);
      const final = await pollNativeSession(session, f.documentId, 0);
      expect(final.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "done",
            text: "로컬 구독으로 수정했습니다.",
          }),
        ]),
      );
      await expect(
        authorizeNativeConnectorJob(
          new Request(
            `https://spellbook.integration.invalid/api/native/jobs/${jobId}/tools`,
            {
              headers: {
                authorization: `Bearer ${submitted.localJob?.capability}`,
              },
            },
          ),
          jobId,
        ),
      ).rejects.toMatchObject({
        status: 409,
        message: "native_connector_job_inactive",
      });
    } finally {
      if (previousMode === undefined)
        delete process.env.SPELLBOOK_AI_CONNECTOR_MODE;
      else process.env.SPELLBOOK_AI_CONNECTOR_MODE = previousMode;
    }
  });

  it.each(["local", "internal"] as const)(
    "fails an interrupted %s connector turn without replaying a possibly applied edit",
    async (execution) => {
      const previousMode = process.env.SPELLBOOK_AI_CONNECTOR_MODE;
      process.env.SPELLBOOK_AI_CONNECTOR_MODE = execution;
      try {
        const f = await fixture();
        const submitted = await submitNativeTurn(session, f.documentId, {
          text: "제목을 바꿔줘",
          permission: "document",
          execution,
        });
        const [created] =
          await db()`select job_id from spellbook_native_turns where id=${submitted.turnId}`;
        const jobId = String(created.job_id);
        const executionToken = `interrupted-${execution}-connector`;
        await executeNativeTool({
          jobId,
          sessionId: f.nativeSessionId,
          executionToken,
          operation: "start",
        });
        const task = (await executeNativeTool({
          jobId,
          sessionId: f.nativeSessionId,
          executionToken,
          operation: "task_create",
          request: { operation: "observe" },
        })) as { taskId: string };
        await db()`update spellbook_jobs set heartbeat_at=now()-interval '10 minutes' where id=${jobId}`;

        const recovered = await pollNativeSession(session, f.documentId, 0);
        expect(recovered.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "error",
              error: expect.stringContaining("AI 작업 연결이 끊겼어요"),
              summary: expect.objectContaining({
                failure: expect.objectContaining({ code: "interrupted" }),
              }),
            }),
          ]),
        );
        const [job] =
          await db()`select status,error from spellbook_jobs where id=${jobId}`;
        const [turn] =
          await db()`select status,last_error from spellbook_native_turns where job_id=${jobId}`;
        const [expiredTask] =
          await db()`select status,error from spellbook_native_tasks where id=${task.taskId}`;
        expect(job).toMatchObject({
          status: "failed",
          error: "native_agent_interrupted",
        });
        expect(turn).toMatchObject({
          status: "failed",
          last_error: expect.stringContaining("다시 요청"),
        });
        expect(expiredTask).toMatchObject({
          status: "expired",
          error: "native_agent_interrupted",
        });
        await expect(
          executeNativeTool({
            jobId,
            sessionId: f.nativeSessionId,
            executionToken,
            operation: "event",
            type: "tool",
            value: "late event",
          }),
        ).rejects.toThrow("native_agent_lease_lost");

        const retry = await submitNativeTurn(session, f.documentId, {
          text: "현재 화면을 보고 계속해줘",
          permission: "document",
          execution,
        });
        const [replacement] =
          await db()`select job_id from spellbook_native_turns where id=${retry.turnId}`;
        expect(replacement.job_id).not.toBe(jobId);
      } finally {
        if (previousMode === undefined)
          delete process.env.SPELLBOOK_AI_CONNECTOR_MODE;
        else process.env.SPELLBOOK_AI_CONNECTOR_MODE = previousMode;
      }
    },
  );

  it("dispatches bounded durable history in chronological order", async () => {
    workers.enqueueWorkerJob.mockClear();
    const f = await fixture();
    await addPastNativeTurn(f, {
      request: "첫 요청",
      response: "첫 응답",
      status: "completed",
      createdAt: new Date(Date.now() - 2_000),
    });
    await addPastNativeTurn(f, {
      request: "두 번째 요청",
      response: null,
      status: "failed",
      createdAt: new Date(Date.now() - 1_000),
    });

    await submitNativeTurn(session, f.documentId, {
      text: "다시 확인해줘",
      permission: "read_only",
    });

    expect(workers.enqueueWorkerJob).toHaveBeenCalledWith(
      expect.any(String),
      "ai",
      "/internal/jobs/native",
      expect.objectContaining({
        conversationHistory: [
          { request: "첫 요청", response: "첫 응답", status: "completed" },
          { request: "두 번째 요청", response: null, status: "failed" },
        ],
      }),
    );
  });

  it("admits a generated image only through a leased edit turn and binds it to the open document", async () => {
    const f = await fixture();
    const submitted = await submitNativeTurn(session, f.documentId, {
      text: "이미지를 만들어 추가",
      permission: "document",
    });
    const [turn] =
      await db()`select * from spellbook_native_turns where id=${submitted.turnId}`;
    const owner = {
      jobId: turn.job_id,
      sessionId: f.nativeSessionId,
      executionToken: "image-worker",
    };
    await executeNativeTool({ ...owner, operation: "start" });
    const png = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 4,
        background: { r: 210, g: 71, b: 38, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const asset = (await executeNativeTool({
      ...owner,
      operation: "asset_create",
      mediaType: "image/png",
      data: png.toString("base64"),
    })) as { assetId: string };

    expect(asset.assetId).toMatch(/^[0-9a-f-]{36}$/i);
    const [stored] =
      await db()`select document_id,content_type,object_name from spellbook_assets where id=${asset.assetId}`;
    expect(stored).toMatchObject({
      document_id: f.documentId,
      content_type: "image/png",
    });
    expect(stored.object_name).toMatch(/\.png$/);
    expect(storage.putObject).toHaveBeenCalledWith(
      stored.object_name,
      png,
      "image/png",
    );
    storage.getObject.mockResolvedValueOnce(png);
    await expect(
      getImageAsset(session, f.documentId, asset.assetId),
    ).resolves.toMatchObject({ data: png, contentType: "image/png" });
    await expect(
      getImageAsset(
        { ...session, accountId: "another-account" },
        f.documentId,
        asset.assetId,
      ),
    ).rejects.toThrow("asset_not_found");
  });

  it("cancellation prevents a late worker from completing the turn", async () => {
    const f = await fixture();
    const submitted = await submitNativeTurn(session, f.documentId, {
      text: "중단",
      permission: "document",
    });
    const [turn] =
      await db()`select * from spellbook_native_turns where id=${submitted.turnId}`;
    await executeNativeTool({
      jobId: turn.job_id,
      sessionId: f.nativeSessionId,
      executionToken: "worker",
      operation: "start",
    });
    await cancelNativeTurn(session, f.documentId);
    await completeNativeTurn(
      { id: turn.job_id },
      {
        jobId: turn.job_id,
        status: "succeeded",
        mode: "native",
        result: {
          text: "늦은 결과",
          changed: true,
          reviewed: true,
          executionToken: "worker",
        },
      },
    );
    const [after] =
      await db()`select status from spellbook_native_turns where id=${turn.id}`;
    expect(after.status).toBe("cancelled");
  });

  it("promotes only a validated latest native save and fails closed", async () => {
    const f = await fixture();
    const saved = randomUUID();
    const jobId = randomUUID();
    await db().begin(async (sql) => {
      await sql`insert into spellbook_versions (id,document_id,parent_version_id,kind,status,document_object)
        values (${saved},${f.documentId},${f.versionId},'approved','processing','native/saved.pptx')`;
      await sql`insert into spellbook_jobs (id,job_type,document_id,version_id,status,payload)
        values (${jobId},'scan_render',${f.documentId},${saved},'queued',${sql.json({ nativeSessionId: f.nativeSessionId, outputPrefix: "native/render" })})`;
      await sql`update spellbook_native_sessions set working_version_id=${saved},status='validating' where id=${f.nativeSessionId}`;
    });
    const callback = {
      jobId,
      status: "succeeded" as const,
      outputs: {
        graphObject: "native/graph.json",
        scanObject: "native/scan.json",
        validationObject: "native/render/validation.json",
        documentSha256: "b".repeat(64),
        slideCount: 1,
      },
    };
    await completeNativeScan(
      {
        id: jobId,
        version_id: saved,
        payload: {
          nativeSessionId: f.nativeSessionId,
          outputPrefix: "native/render",
        },
      },
      callback,
    );
    const [document] =
      await db()`select current_version_id from spellbook_documents where id=${f.documentId}`;
    expect(document.current_version_id).toBe(saved);

    const failed = randomUUID();
    const failedJob = randomUUID();
    await db().begin(async (sql) => {
      await sql`insert into spellbook_versions (id,document_id,parent_version_id,kind,status,document_object)
        values (${failed},${f.documentId},${saved},'approved','processing','native/failed.pptx')`;
      await sql`insert into spellbook_jobs (id,job_type,document_id,version_id,status,payload)
        values (${failedJob},'scan_render',${f.documentId},${failed},'queued',${sql.json({ nativeSessionId: f.nativeSessionId, outputPrefix: "native/failed-render" })})`;
      await sql`update spellbook_native_sessions set working_version_id=${failed},status='validating' where id=${f.nativeSessionId}`;
    });
    await failNativeScan(
      {
        id: failedJob,
        version_id: failed,
        payload: {
          nativeSessionId: f.nativeSessionId,
          outputPrefix: "native/failed-render",
        },
      },
      "invalid package",
    );
    const [unchanged] =
      await db()`select current_version_id from spellbook_documents where id=${f.documentId}`;
    const [native] =
      await db()`select status from spellbook_native_sessions where id=${f.nativeSessionId}`;
    expect(unchanged.current_version_id).toBe(saved);
    expect(native.status).toBe("failed");
    await expect(
      pollNativeSession(session, f.documentId, 0),
    ).resolves.toMatchObject({
      session: { status: "failed", error: "invalid package" },
    });
  });
});
