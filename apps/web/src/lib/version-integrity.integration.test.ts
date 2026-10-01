import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Session } from "./models";
import { isolatedPostgresTestUrl } from "./postgres-test-schema";

const storage = vi.hoisted(() => ({ getJsonObject: vi.fn() }));
vi.mock("./storage", () => ({
  ...storage,
  storageNamespace: () => "test-storageNamespace",
  getObject: vi.fn(),
  putObject: vi.fn(),
  accountPrefix: (account: string, document: string) =>
    `accounts/${Buffer.from(account).toString("base64url")}/documents/${document}`,
}));
vi.mock("./workers", () => ({ enqueueWorkerJob: vi.fn() }));
vi.mock("./db", async (original) => ({
  ...(await original<typeof import("./db")>()),
  ensureSchema: async () => {},
}));
import { db } from "./db";
import { enqueueWorkerJob } from "./workers";
import { steerConversation, readConversation } from "./conversation";
import { updateAiPermission } from "./ai-permissions";
import { uploadImage } from "./image-assets";
import sharp from "sharp";
import {
  approveCandidate,
  createEdit,
  createManualEdit,
  downloadCurrent,
  documentDetail,
  handleWorkerCallback,
  executeAgentTool,
  cancelDocumentTurn,
  rejectCandidate,
  undoDocument,
} from "./orchestration";

const enabled = process.env.SPELLBOOK_VERSION_INTEGRATION === "1";
const accountId = `spellbook-version-test-${randomUUID()}`;
const testSchema = `spellbook_test_${randomUUID().replaceAll("-", "")}`;
const session: Session = {
  accountId,
  email: "owner@example.test",
  admin: true,
  token: "test-only",
};
const ownedDocuments: string[] = [];
const graph = {
  contractVersion: "1.0",
  documentSha256: "0".repeat(64),
  slides: [
    {
      slideIndex: 0,
      partUri: "/ppt/slides/slide1.xml",
      previewObject: "test-preview",
      elements: [{ elementId: "shape-1", editable: true, kind: "shape" }],
    },
  ],
};

beforeAll(async () => {
  if (!enabled) return;
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://spellbook.integration.invalid");
  vi.stubEnv("DATABASE_URL", await isolatedPostgresTestUrl(testSchema));
  const actual = await vi.importActual<typeof import("./db")>("./db");
  await actual.ensureSchema();
});

async function fixture(status = "candidate_ready", stale = false) {
  const doc = randomUUID(),
    original = randomUUID(),
    base = randomUUID(),
    candidate = randomUUID(),
    edit = randomUUID();
  ownedDocuments.push(doc);
  await db().begin(async (sql) => {
    await sql`insert into spellbook_documents (id, account_id, file_name, status) values (${doc}, ${accountId}, 'integration-only.pptx', ${status})`;
    for (const [id, parent, kind] of [
      [original, null, "original"],
      [base, original, "approved"],
      [candidate, stale ? original : base, "candidate"],
    ]) {
      await sql`insert into spellbook_versions (id, document_id, parent_version_id, kind, status, document_object, graph_object, document_sha256)
        values (${id!}, ${doc}, ${parent}, ${kind!}, 'ready', ${`integration-only/${doc}/${id}`}, 'test-graph', ${"0".repeat(64)})`;
    }
    await sql`update spellbook_documents set original_version_id=${original}, current_version_id=${base} where id=${doc}`;
    await sql`update spellbook_versions set slide_count = 1 where document_id = ${doc}`;
    await sql`insert into spellbook_edit_requests (id, document_id, account_id, base_version_id, candidate_version_id, request_text, status)
      values (${edit}, ${doc}, ${accountId}, ${stale ? original : base}, ${candidate}, 'integration-only', 'candidate_ready')`;
  });
  storage.getJsonObject.mockResolvedValue(graph);
  return { doc, original, base, candidate, edit };
}

afterEach(async () => {
  if (!enabled) return;
  for (const id of ownedDocuments.splice(0))
    await db()`delete from spellbook_documents where id=${id} and account_id=${accountId}`;
  storage.getJsonObject.mockReset();
  vi.mocked(enqueueWorkerJob).mockReset();
});
afterAll(async () => {
  if (enabled) {
    await db().unsafe(`drop schema if exists "${testSchema}" cascade`);
    await db().end();
  }
});

describe.skipIf(!enabled)(
  "real PostgreSQL version transitions (isolated owned rows; no worker dispatch)",
  () => {
    it("direct editing is owner-scoped, idempotent and saves a native version without AI or widening AI permission", async () => {
      const f = await fixture("ready");
      const source = structuredClone(graph);
      Object.assign(source.slides[0].elements[0], {
        sourceHash: "a".repeat(64),
      });
      storage.getJsonObject.mockImplementation(async (key) =>
        key === "manual-validation" ? { valid: true } : source,
      );
      await db()`update spellbook_documents set ai_permission='{"mode":"read_only","slideIndexes":[]}'::jsonb where id=${f.doc}`;
      const input = {
        requestId: randomUUID(),
        baseVersionId: f.base,
        command: {
          contractVersion: "1.0",
          baseDocumentSha256: source.documentSha256,
          summary: "direct title",
          commands: [
            {
              op: "replace_text",
              target: {
                slideIndex: 0,
                elementId: "shape-1",
                sourceHash: "a".repeat(64),
              },
              text: "manual",
            },
          ],
        },
      };
      await expect(
        createManualEdit({ ...session, accountId: "not-owner" }, f.doc, input),
      ).rejects.toThrow("document_not_found");
      const result = await createManualEdit(session, f.doc, input);
      expect(await createManualEdit(session, f.doc, input)).toEqual(result);
      const [job] =
        await db()`select * from spellbook_jobs where edit_request_id=${result.editRequestId}`;
      expect(job.job_type).toBe("patch_render");
      expect(job.payload.execution).toBe("manual");
      await expect(
        createManualEdit(session, f.doc, {
          ...input,
          command: { ...input.command, summary: "different" },
        }),
      ).rejects.toThrow("manual_request_id_reused");
      const callback = {
        jobId: job.id,
        status: "succeeded" as const,
        outputs: {
          graphObject: "manual-graph",
          validationObject: "manual-validation",
          documentObject: job.payload.outputDocumentObject,
          documentSha256: source.documentSha256,
          slideCount: 1,
        },
      };
      await handleWorkerCallback(callback);
      await handleWorkerCallback(callback);
      const [document] =
        await db()`select * from spellbook_documents where id=${f.doc}`;
      expect(document.current_version_id).toBe(job.version_id);
      expect(document.status).toBe("ready");
      expect(document.ai_permission.mode).toBe("read_only");
      expect(
        (
          await db()`select job_type from spellbook_jobs where document_id=${f.doc}`
        ).map((j) => j.job_type),
      ).toEqual(["patch_render"]);
      expect((await documentDetail(session, f.doc)).latestEdit).toMatchObject({
        execution: "manual",
        status: "approved",
        aiAttempts: 0,
      });
      await undoDocument(session, f.doc);
      expect((await documentDetail(session, f.doc)).currentVersionId).toBe(
        f.base,
      );
    });

    it("direct edits reject stale versions and AI candidates without implicitly approving them", async () => {
      const f = await fixture();
      const input = {
        requestId: randomUUID(),
        baseVersionId: f.base,
        command: {
          contractVersion: "1.0",
          baseDocumentSha256: "0".repeat(64),
          summary: "new text",
          commands: [
            {
              op: "add_text_box",
              slideIndex: 0,
              x: 0,
              y: 0,
              width: 100,
              height: 100,
              text: "test",
            },
          ],
        },
      };
      await expect(createManualEdit(session, f.doc, input)).rejects.toThrow(
        "문서가 변경",
      );
      await rejectCandidate(session, f.doc, f.edit);
      await expect(
        createManualEdit(session, f.doc, {
          ...input,
          baseVersionId: f.original,
        }),
      ).rejects.toThrow("문서가 변경");
      expect(
        await db()`select * from spellbook_jobs where document_id=${f.doc}`,
      ).toHaveLength(0);
    });

    it("cancelled manual callbacks cannot resurrect a version", async () => {
      const f = await fixture("ready");
      const result = await createManualEdit(session, f.doc, {
        requestId: randomUUID(),
        baseVersionId: f.base,
        command: {
          contractVersion: "1.0",
          baseDocumentSha256: "0".repeat(64),
          summary: "new text",
          commands: [
            {
              op: "add_text_box",
              slideIndex: 0,
              x: 0,
              y: 0,
              width: 100,
              height: 100,
              text: "test",
            },
          ],
        },
      });
      const [job] =
        await db()`select * from spellbook_jobs where edit_request_id=${result.editRequestId}`;
      await cancelDocumentTurn(session, f.doc);
      await handleWorkerCallback({
        jobId: job.id,
        status: "succeeded",
        outputs: {
          graphObject: "late",
          validationObject: "late",
          documentObject: "late",
          documentSha256: "1".repeat(64),
          slideCount: 1,
        },
      });
      expect((await documentDetail(session, f.doc)).currentVersionId).toBe(
        f.base,
      );
    });
    it("rejects an unsupported target before creating a version and leaves the agent able to retry", async () => {
      const f = await fixture("ready");
      const source = structuredClone(graph);
      Object.assign(source.slides[0].elements[0], {
        kind: "graphicFrame",
        sourceHash: "a".repeat(64),
        tableCells: [["cell"]],
      });
      storage.getJsonObject.mockResolvedValue(source);
      const turn = await createEdit(session, f.doc, {
        requestText: "table",
        selectedElementIds: ["shape-1"],
        selectedSlideIndexes: [],
      });
      const [agent] =
        await db()`select id from spellbook_jobs where edit_request_id=${turn.editRequestId}`;
      const owner = { jobId: agent.id, executionToken: "capability-owner" };
      await executeAgentTool({ ...owner, operation: "start" });
      const target = {
        elementId: "shape-1",
        slideIndex: 0,
        sourceHash: "a".repeat(64),
      };
      const command = {
        contractVersion: "1.0",
        baseDocumentSha256: source.documentSha256,
        summary: "table",
        commands: [{ op: "set_text_style", target, fontSize: 28 }],
      };
      await expect(
        executeAgentTool({
          ...owner,
          operation: "edit",
          callId: "wrong-kind",
          command,
        }),
      ).rejects.toThrow("requires shape");
      const jobs =
        await db()`select id from spellbook_jobs where edit_request_id=${turn.editRequestId}`;
      expect(jobs).toHaveLength(1);
      expect(
        await executeAgentTool({ ...owner, operation: "observe" }),
      ).toMatchObject({ status: "ready", candidateVersionId: null });
      await executeAgentTool({
        ...owner,
        operation: "edit",
        callId: "retry",
        command: {
          ...command,
          commands: [
            {
              op: "set_table_cell",
              target,
              row: 0,
              column: 0,
              text: "changed",
            },
          ],
        },
      });
      const patches =
        await db()`select id from spellbook_jobs where edit_request_id=${turn.editRequestId} and job_type='patch_render'`;
      expect(patches).toHaveLength(1);
    });
    it("requires document permission for creation, observes all new pages and resolves image assets only from this document", async () => {
      const f = await fixture("ready");
      const turn = await createEdit(session, f.doc, {
        requestText: "두 번째 슬라이드 추가",
        selectedElementIds: [],
        selectedSlideIndexes: [0],
      });
      const [agent] =
        await db()`select id from spellbook_jobs where edit_request_id = ${turn.editRequestId}`;
      const owner = { jobId: agent.id, executionToken: "structural-owner" };
      await executeAgentTool({ ...owner, operation: "start" });
      const command = {
        contractVersion: "1.0",
        baseDocumentSha256: graph.documentSha256,
        summary: "new slide",
        commands: [{ op: "add_slide", templateSlideIndex: 0, insertIndex: 1 }],
      };
      await expect(
        executeAgentTool({
          ...owner,
          operation: "edit",
          callId: "add",
          command,
        }),
      ).rejects.toThrow(/document-wide/);
      await updateAiPermission(session, f.doc, {
        permission: { mode: "document", slideIndexes: [] },
      });
      await executeAgentTool({
        ...owner,
        operation: "edit",
        callId: "add",
        command,
      });
      const [patch] =
        await db()`select * from spellbook_jobs where edit_request_id=${turn.editRequestId} and job_type='patch_render'`;
      const next = {
        ...graph,
        slides: [
          ...graph.slides,
          {
            slideIndex: 1,
            partUri: "/ppt/slides/slide-spellbook-new.xml",
            previewObject: "new-preview",
            elements: [],
          },
        ],
      };
      storage.getJsonObject.mockImplementation(async (object) =>
        object === "new-graph" ? next : graph,
      );
      await handleWorkerCallback({
        jobId: patch.id,
        status: "succeeded",
        outputs: {
          graphObject: "new-graph",
          validationObject: "valid",
          documentObject: patch.payload.outputDocumentObject,
          slideCount: 2,
          documentSha256: graph.documentSha256,
        },
      });
      expect(
        ((await executeAgentTool({ ...owner, operation: "observe" })) as any)
          .changedSlideIndexes,
      ).toEqual([0, 1]);
      await updateAiPermission(session, f.doc, {
        permission: { mode: "slides", slideIndexes: [1] },
      });
      const [document] =
        await db()`select ai_permission from spellbook_documents where id=${f.doc}`;
      expect(document.ai_permission.slidePartUris).toEqual([
        "/ppt/slides/slide-spellbook-new.xml",
      ]);
      const png = await sharp({
        create: { width: 4, height: 4, channels: 3, background: "#fff" },
      })
        .png()
        .toBuffer();
      const asset = await uploadImage(
        session,
        f.doc,
        new File([new Uint8Array(png)], "fixture.png", { type: "image/png" }),
      );
      await expect(
        uploadImage(
          { ...session, accountId: "other" },
          f.doc,
          new File([new Uint8Array(png)], "fixture.png"),
        ),
      ).rejects.toThrow("document_not_found");
      const imageCommand = {
        ...command,
        commands: [
          {
            op: "add_image",
            slideIndex: 1,
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            assetId: randomUUID(),
          },
        ],
      };
      await expect(
        executeAgentTool({
          ...owner,
          operation: "edit",
          callId: "bad-image",
          command: imageCommand,
        }),
      ).rejects.toThrow("image_asset_not_in_document");
      imageCommand.commands[0].assetId = asset.assetId;
      await executeAgentTool({
        ...owner,
        operation: "edit",
        callId: "image",
        command: imageCommand,
      });
      const [imageJob] =
        await db()`select payload from spellbook_jobs where edit_request_id=${turn.editRequestId} and payload->>'agentCallId'='image'`;
      expect(Object.keys(imageJob.payload.assetObjects)).toEqual([
        asset.assetId,
      ]);
      await cancelDocumentTurn(session, f.doc);
    }, 30000);
    it("persists independent streamed items and additional input with ownership, deduplication and cancellation", async () => {
      const f = await fixture("ready");
      const turn = await createEdit(session, f.doc, {
        requestText: "현재 화면 설명",
        selectedElementIds: [],
        selectedSlideIndexes: [0],
      });
      const [agent] =
        await db()`select id from spellbook_jobs where edit_request_id = ${turn.editRequestId}`;
      const owner = { jobId: agent.id, executionToken: "owner" };
      await executeAgentTool({ ...owner, operation: "start" });
      const request = { text: "색은 바꾸지 마", requestId: randomUUID() };
      const first = await steerConversation(session, f.doc, request);
      expect((await steerConversation(session, f.doc, request)).id).toBe(
        first.id,
      );
      await expect(
        readConversation({ ...session, accountId: "foreign" }, f.doc),
      ).rejects.toThrow("document_not_found");
      await expect(
        steerConversation({ ...session, accountId: "foreign" }, f.doc, request),
      ).rejects.toThrow("document_not_found");
      expect(
        ((await executeAgentTool({ ...owner, operation: "inbox" })) as any)
          .messages,
      ).toHaveLength(1);
      expect(
        ((await executeAgentTool({ ...owner, operation: "inbox" })) as any)
          .messages,
      ).toHaveLength(0);
      await executeAgentTool({
        ...owner,
        operation: "ack",
        messageId: String(first.id),
        status: "accepted",
      });
      for (const [revision, message] of [
        [2, "현재 화면을 확인했습니다"],
        [1, "현재"],
      ] as const)
        await executeAgentTool({
          ...owner,
          operation: "event",
          itemId: "answer",
          role: "assistant",
          status: "streaming",
          revision,
          message,
        });
      let state = await readConversation(session, f.doc);
      expect(
        state.messages.find((m) => m.sourceKey === "answer")?.content,
      ).toBe("현재 화면을 확인했습니다");
      expect(
        state.messages.find((m) => m.id === String(first.id))?.status,
      ).toBe("accepted");
      const late = await steerConversation(session, f.doc, {
        text: "아직 하나 더",
        requestId: randomUUID(),
      });
      await cancelDocumentTurn(session, f.doc);
      state = await readConversation(session, f.doc);
      expect(state.messages.find((m) => m.id === String(late.id))?.status).toBe(
        "not_delivered",
      );
      expect(state.messages.find((m) => m.sourceKey === "answer")?.status).toBe(
        "interrupted",
      );
      await expect(
        executeAgentTool({
          ...owner,
          operation: "event",
          itemId: "answer",
          role: "assistant",
          status: "completed",
          revision: 3,
          message: "늦은 답변",
        }),
      ).rejects.toThrow("agent_turn_inactive");
    }, 30000);
    it("agent tools edit once, return the new version, and keep late callbacks inert after cancellation", async () => {
      const f = await fixture("ready");
      const source = structuredClone(graph);
      Object.assign(source.slides[0].elements[0], {
        sourceHash: "a".repeat(64),
        shapeId: 2,
      });
      storage.getJsonObject.mockResolvedValue(source);
      const turn = await createEdit(session, f.doc, {
        requestText: "제목 변경",
        selectedElementIds: ["shape-1"],
        selectedSlideIndexes: [],
      });
      const [agent] =
        await db()`select * from spellbook_jobs where edit_request_id = ${turn.editRequestId}`;
      await executeAgentTool({
        jobId: agent.id,
        operation: "start",
        executionToken: "owner",
      });
      await expect(
        executeAgentTool({
          jobId: agent.id,
          operation: "start",
          executionToken: "other",
        }),
      ).rejects.toThrow("agent_already_running");
      await expect(
        executeAgentTool({
          jobId: agent.id,
          operation: "observe",
          executionToken: "other",
        }),
      ).rejects.toThrow("agent_lease_lost");
      const command = {
        contractVersion: "1.0",
        baseDocumentSha256: graph.documentSha256,
        summary: "제목 변경",
        commands: [
          {
            op: "replace_text",
            target: {
              slideIndex: 0,
              elementId: "shape-1",
              sourceHash: "a".repeat(64),
            },
            text: "새 제목",
          },
        ],
      };
      const before = await executeAgentTool({
        executionToken: "owner",
        jobId: agent.id,
        operation: "observe",
      });
      expect(before.versionId).toBe(f.base);
      await updateAiPermission(session, f.doc, {
        permission: { mode: "read_only", slideIndexes: [] },
      });
      await expect(
        executeAgentTool({
          executionToken: "owner",
          jobId: agent.id,
          operation: "edit",
          callId: "blocked",
          command,
        }),
      ).rejects.toThrow("ai_edit_permission_required");
      const request = (await executeAgentTool({
        executionToken: "owner",
        jobId: agent.id,
        operation: "request_permission",
        callId: "permission",
        permission: { mode: "slides", slideIndexes: [0] },
        message: "1번 슬라이드를 수정하도록 허용해주세요",
      })) as { messageId: string };
      expect(
        (
          (await executeAgentTool({
            executionToken: "owner",
            jobId: agent.id,
            operation: "permission_status",
            messageId: request.messageId,
          })) as any
        ).status,
      ).toBe("permission_pending");
      await expect(
        updateAiPermission({ ...session, accountId: "foreign" }, f.doc, {
          messageId: request.messageId,
          decision: "grant",
        }),
      ).rejects.toThrow("document_not_found");
      await updateAiPermission(session, f.doc, {
        messageId: request.messageId,
        decision: "grant",
      });
      expect(
        (
          (await executeAgentTool({
            executionToken: "owner",
            jobId: agent.id,
            operation: "permission_status",
            messageId: request.messageId,
          })) as any
        ).permission,
      ).toEqual({
        mode: "slides",
        slideIndexes: [0],
        slidePartUris: ["/ppt/slides/slide1.xml"],
      });
      const applied = await executeAgentTool({
        executionToken: "owner",
        jobId: agent.id,
        operation: "edit",
        callId: "tool-1",
        command,
      });
      const replay = await executeAgentTool({
        executionToken: "owner",
        jobId: agent.id,
        operation: "edit",
        callId: "tool-1",
        command,
      });
      expect(replay.versionId).toBe(applied.versionId);
      const patches =
        await db()`select * from spellbook_jobs where edit_request_id = ${turn.editRequestId} and job_type = 'patch_render'`;
      expect(patches).toHaveLength(1);
      await expect(
        cancelDocumentTurn({ ...session, accountId: "foreign" }, f.doc),
      ).rejects.toThrow();
      await cancelDocumentTurn(session, f.doc);
      await expect(
        executeAgentTool({ jobId: agent.id, operation: "observe" }),
      ).rejects.toThrow("agent_turn_inactive");
      await handleWorkerCallback({
        jobId: patches[0].id,
        status: "succeeded",
        outputs: {
          graphObject: "late",
          validationObject: "late-validation",
          documentObject: "late-pptx",
          documentSha256: "b".repeat(64),
          slideCount: 1,
        },
      });
      const [document] =
        await db()`select * from spellbook_documents where id = ${f.doc}`;
      expect(document.status).toBe("ready");
      expect(document.current_version_id).toBe(f.base);
      const [candidate] =
        await db()`select * from spellbook_versions where id = ${applied.versionId!}`;
      expect(candidate.status).toBe("failed");
      expect(candidate.graph_object).toBeNull();
    });
    it.each(["ready", "candidate_ready"])(
      "answers a question on %s without patching or changing the working version",
      async (status) => {
        const f = await fixture(status);
        const result = await createEdit(session, f.doc, {
          requestText: "지금 제목이 무엇인지 설명해줘. 수정하지 마.",
          selectedElementIds: [],
          selectedSlideIndexes: [0],
          ...(status === "candidate_ready"
            ? { baseCandidateEditId: f.edit }
            : {}),
        });
        const [job] =
          await db()`select * from spellbook_jobs where edit_request_id = ${result.editRequestId}`;
        expect(job.payload.conversational).toBe(true);
        expect(job.payload.conversationHistory[0].request).toBe(
          "integration-only",
        );
        const callback = {
          jobId: job.id,
          status: "succeeded" as const,
          result: {
            message: "제목을 설명합니다. 파일은 바꾸지 않았습니다.",
            candidateVersionId: null,
            approved: false,
            problems: [],
          },
        };
        await handleWorkerCallback(callback);
        await handleWorkerCallback(callback);
        const [turn] =
          await db()`select * from spellbook_edit_requests where id = ${result.editRequestId}`;
        expect(turn.status).toBe("answered");
        expect(turn.assistant_message).toBe(callback.result.message);
        expect(turn.candidate_version_id).toBeNull();
        const [doc] =
          await db()`select * from spellbook_documents where id = ${f.doc}`;
        expect(doc.current_version_id).toBe(f.base);
        expect(doc.status).toBe(status);
        const jobs =
          await db()`select * from spellbook_jobs where edit_request_id = ${result.editRequestId}`;
        expect(jobs).toHaveLength(1);
        if (status === "candidate_ready") {
          const [parent] =
            await db()`select * from spellbook_edit_requests where id = ${f.edit}`;
          expect(parent.status).toBe("candidate_ready");
          const detail = await documentDetail(session, f.doc);
          expect(detail.candidateGraph).toEqual(graph);
          expect(detail.latestEdit?.id).toBe(f.edit);
          expect(detail.history?.[0].assistantMessage).toBe(
            callback.result.message,
          );
        }
      },
    );
    it("retains queued work when initial task delivery fails", async () => {
      const f = await fixture("ready");
      vi.mocked(enqueueWorkerJob).mockRejectedValueOnce(
        new Error("temporary queue outage"),
      );
      const result = await createEdit(session, f.doc, {
        requestText: "test",
        selectedElementIds: ["shape-1"],
        selectedSlideIndexes: [],
      });
      const [job] =
        await db()`select * from spellbook_jobs where edit_request_id = ${result.editRequestId}`;
      expect(job.status).toBe("queued");
      expect(job.dispatched_at).toBeNull();
      const [base] =
        await db()`select status from spellbook_versions where id = ${f.base}`;
      expect(base.status).toBe("ready");
      await documentDetail(session, f.doc);
      const [recovered] =
        await db()`select dispatched_at from spellbook_jobs where id = ${job.id}`;
      expect(recovered.dispatched_at).not.toBeNull();
    });

    it("redelivers an accepted job whose local worker lease expired", async () => {
      const f = await fixture("ready");
      const result = await createEdit(session, f.doc, {
        requestText: "test",
        selectedElementIds: ["shape-1"],
        selectedSlideIndexes: [],
      });
      const [job] =
        await db()`select * from spellbook_jobs where edit_request_id = ${result.editRequestId}`;
      const firstDispatch = job.dispatched_at;
      expect(firstDispatch).not.toBeNull();
      vi.mocked(enqueueWorkerJob).mockClear();
      await db()`update spellbook_jobs set dispatched_at = now() - interval '10 minutes' where id = ${job.id}`;
      await documentDetail(session, f.doc);
      expect(enqueueWorkerJob).toHaveBeenCalledOnce();
      const [recovered] =
        await db()`select dispatched_at from spellbook_jobs where id = ${job.id}`;
      expect(recovered.dispatched_at.getTime()).toBeGreaterThan(
        firstDispatch.getTime(),
      );
    });

    it("does not duplicate a job while its local worker lease is current", async () => {
      const f = await fixture("ready");
      await createEdit(session, f.doc, {
        requestText: "test",
        selectedElementIds: ["shape-1"],
        selectedSlideIndexes: [],
      });
      vi.mocked(enqueueWorkerJob).mockClear();
      await documentDetail(session, f.doc);
      expect(enqueueWorkerJob).not.toHaveBeenCalled();
    });

    it("unchanged document polling skips all graph object reads", async () => {
      const f = await fixture("ready");
      const first = await documentDetail(session, f.doc);
      storage.getJsonObject.mockClear();
      const second = await documentDetail(session, f.doc, first.revision);
      expect(second).toMatchObject({
        notModified: true,
        revision: first.revision,
      });
      expect(storage.getJsonObject).not.toHaveBeenCalled();
    });
    it("refinement keeps the approved base but plans from the displayed candidate", async () => {
      const f = await fixture();
      const result = await createEdit(session, f.doc, {
        requestText: "keep the earlier change and refine it",
        selectedElementIds: ["shape-1"],
        selectedSlideIndexes: [],
        baseCandidateEditId: f.edit,
      });
      const [row] =
        await db()`select * from spellbook_edit_requests where id = ${result.editRequestId}`;
      expect(row.base_version_id).toBe(f.base);
      expect(row.input_version_id).toBe(f.candidate);
      expect(row.parent_edit_request_id).toBe(f.edit);
      const [document] =
        await db()`select current_version_id from spellbook_documents where id = ${f.doc}`;
      expect(document.current_version_id).toBe(f.base);
    });

    it("rejects refinement from another document's candidate", async () => {
      const first = await fixture();
      const second = await fixture();
      await expect(
        createEdit(session, first.doc, {
          requestText: "test",
          selectedElementIds: ["shape-1"],
          selectedSlideIndexes: [],
          baseCandidateEditId: second.edit,
        }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it("a failed refinement restores its previous candidate without changing the approved base", async () => {
      const f = await fixture();
      const result = await createEdit(session, f.doc, {
        requestText: "refine",
        selectedElementIds: ["shape-1"],
        selectedSlideIndexes: [],
        baseCandidateEditId: f.edit,
      });
      const [job] =
        await db()`select id from spellbook_jobs where edit_request_id = ${result.editRequestId}`;
      await handleWorkerCallback({
        jobId: job.id,
        status: "failed",
        error: "subscription_unavailable",
      });
      const [document] =
        await db()`select * from spellbook_documents where id = ${f.doc}`;
      const [prior] =
        await db()`select * from spellbook_edit_requests where id = ${f.edit}`;
      const [version] =
        await db()`select * from spellbook_versions where id = ${f.base}`;
      expect(document.status).toBe("candidate_ready");
      expect(document.current_version_id).toBe(f.base);
      expect(prior.status).toBe("candidate_ready");
      expect(version.status).toBe("ready");
      await expect(downloadCurrent(session, f.doc)).resolves.toMatchObject({
        name: "integration-only.pptx",
      });
    });
    it("admits only one simultaneous edit of the same document state", async () => {
      const f = await fixture("ready");
      let arrived = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      storage.getJsonObject.mockImplementation(async () => {
        if (++arrived === 2) release();
        await barrier;
        return graph;
      });
      const input = {
        requestText: "test",
        selectedElementIds: ["shape-1"],
        selectedSlideIndexes: [0],
      };
      const results = await Promise.allSettled([
        createEdit(session, f.doc, input),
        createEdit(session, f.doc, input),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rows =
        await db()`select id from spellbook_jobs where document_id=${f.doc}`;
      expect(rows).toHaveLength(1);
    }, 30_000);

    it("approves a candidate once when requests arrive together", async () => {
      const f = await fixture();
      const results = await Promise.allSettled([
        approveCandidate(session, f.doc, f.edit),
        approveCandidate(session, f.doc, f.edit),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(
        (
          await db()`select current_version_id from spellbook_documents where id=${f.doc}`
        )[0]?.current_version_id,
      ).toBe(f.candidate);
    }, 30_000);

    it("cannot approve a candidate based on an older version", async () => {
      const f = await fixture("candidate_ready", true);
      await expect(approveCandidate(session, f.doc, f.edit)).rejects.toThrow(
        "candidate_not_ready",
      );
      expect(
        (
          await db()`select current_version_id from spellbook_documents where id=${f.doc}`
        )[0]?.current_version_id,
      ).toBe(f.base);
    }, 30_000);

    it("approval and rejection cannot both win", async () => {
      const f = await fixture();
      const results = await Promise.allSettled([
        approveCandidate(session, f.doc, f.edit),
        rejectCandidate(session, f.doc, f.edit),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    }, 30_000);

    it("undo invalidates an unapproved candidate", async () => {
      const f = await fixture();
      await undoDocument(session, f.doc);
      await expect(approveCandidate(session, f.doc, f.edit)).rejects.toThrow(
        "candidate_not_ready",
      );
      expect(
        (
          await db()`select current_version_id from spellbook_documents where id=${f.doc}`
        )[0]?.current_version_id,
      ).toBe(f.original);
    }, 30_000);

    it("cannot undo while an edit is running", async () => {
      const f = await fixture("editing");
      await expect(undoDocument(session, f.doc)).rejects.toThrow(
        "document_not_ready",
      );
    }, 30_000);

    it("allows distinct documents to progress and keeps ownership checks", async () => {
      const first = await fixture(),
        second = await fixture();
      await expect(
        approveCandidate(
          { ...session, accountId: "unrelated" },
          first.doc,
          first.edit,
        ),
      ).rejects.toThrow("document_not_found");
      await Promise.all([
        approveCandidate(session, first.doc, first.edit),
        approveCandidate(session, second.doc, second.edit),
      ]);
    }, 30_000);
  },
);
