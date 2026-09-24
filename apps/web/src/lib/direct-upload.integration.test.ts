import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Session } from "./models";

const storage = vi.hoisted(() => ({
  directWriteTarget: vi.fn(),
  objectHead: vi.fn(),
  deleteObject: vi.fn(async () => {}),
}));
vi.mock("./storage", () => ({
  ...storage,
  storageNamespace: () => "test-storageNamespace",
  getObject: vi.fn(),
  putObject: vi.fn(),
  getJsonObject: vi.fn(),
  directReadUrl: vi.fn(async () => null),
  accountPrefix: (account: string, document: string) =>
    `accounts/${Buffer.from(account).toString("base64url")}/documents/${document}`,
}));
vi.mock("./workers", () => ({ enqueueWorkerJob: vi.fn() }));
vi.mock("./db", async (original) => ({
  ...(await original<typeof import("./db")>()),
  ensureSchema: async () => {},
}));
import { db } from "./db";
import { completeDirectUpload, startDirectUpload } from "./orchestration";

const enabled = process.env.SPELLBOOK_VERSION_INTEGRATION === "1";
const testSchema = `spellbook_upload_${randomUUID().replaceAll("-", "")}`;
const session: Session = {
  accountId: `direct-upload-${randomUUID()}`,
  email: "owner@example.test",
  admin: true,
  token: "test-only",
};
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

beforeAll(async () => {
  if (!enabled) return;
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://spellbook.integration.invalid");
  vi.stubEnv("SPELLBOOK_WOPI_SECRET", "direct-upload-test-secret-1234567890");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const administrator = postgres(databaseUrl, { max: 1, prepare: false });
  await administrator.unsafe(`create schema "${testSchema}"`);
  await administrator.end();
  const isolatedUrl = new URL(databaseUrl);
  isolatedUrl.searchParams.set("options", `-csearch_path=${testSchema}`);
  vi.stubEnv("DATABASE_URL", isolatedUrl.toString());
  const actual = await vi.importActual<typeof import("./db")>("./db");
  await actual.ensureSchema();
});
afterAll(async () => {
  if (!enabled) return;
  await db().unsafe(`drop schema if exists "${testSchema}" cascade`);
  await db().end();
  vi.unstubAllEnvs();
});

async function started(size = 1_000) {
  storage.directWriteTarget.mockResolvedValueOnce({
    url: "https://storage.invalid/signed",
    headers: { "content-type": "application/pptx" },
  });
  const target = await startDirectUpload(session, {
    fileName: "deck.pptx",
    size,
  });
  if (!target.direct) throw new Error("expected a direct upload");
  return target;
}

describe.skipIf(!enabled)("upload straight from the browser to storage", () => {
  it("falls back to posting the file when storage has no direct link", async () => {
    storage.directWriteTarget.mockResolvedValueOnce(null);
    await expect(
      startDirectUpload(session, { fileName: "deck.pptx", size: 1_000 }),
    ).resolves.toEqual({ direct: false });
  });

  it("refuses the same reasons as a posted upload before signing anything", async () => {
    await expect(
      startDirectUpload(session, { fileName: "deck.key", size: 10 }),
    ).rejects.toMatchObject({ status: 400, message: "unsupported_format" });
    await expect(
      startDirectUpload(session, { fileName: "deck.pptx", size: 0 }),
    ).rejects.toMatchObject({ status: 400, message: "empty_file" });
    await expect(
      startDirectUpload(session, {
        fileName: "deck.pptx",
        size: 200 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({ status: 400, message: "file_too_large" });
  });

  it("records a stored package once and only for the account that started it", async () => {
    const target = await started();
    await expect(
      completeDirectUpload(
        { ...session, accountId: "someone-else" },
        target.token,
      ),
    ).rejects.toMatchObject({ status: 400, message: "invalid_upload" });
    storage.objectHead.mockResolvedValue({ size: 1_000, head: ZIP });
    const first = await completeDirectUpload(session, target.token);
    const [row] =
      await db()`select account_id, file_name, status from spellbook_documents where id=${first.id}`;
    expect(row).toMatchObject({
      account_id: session.accountId,
      file_name: "deck.pptx",
      status: "processing",
    });
    const [version] =
      await db()`select document_bytes from spellbook_versions where document_id=${first.id}`;
    expect(Number(version.document_bytes)).toBe(1_000);
    // A repeated completion (for example after a lost response) is harmless.
    await expect(completeDirectUpload(session, target.token)).resolves.toEqual(
      first,
    );
  });

  it("deletes what was stored when it is not the announced PowerPoint package", async () => {
    const shortUpload = await started();
    storage.objectHead.mockResolvedValueOnce({ size: 400, head: ZIP });
    await expect(
      completeDirectUpload(session, shortUpload.token),
    ).rejects.toMatchObject({ status: 400, message: "upload_incomplete" });
    const legacy = await started();
    storage.objectHead.mockResolvedValueOnce({
      size: 1_000,
      head: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]),
    });
    await expect(
      completeDirectUpload(session, legacy.token),
    ).rejects.toMatchObject({
      status: 400,
      message: "encrypted_or_legacy_file",
    });
    expect(storage.deleteObject).toHaveBeenCalledTimes(2);
    const missing = await started();
    storage.objectHead.mockResolvedValueOnce(null);
    await expect(
      completeDirectUpload(session, missing.token),
    ).rejects.toMatchObject({ status: 409, message: "upload_not_found" });
  });

  it("does not accept a changed or foreign token", async () => {
    const target = await started();
    const [payload, signature] = target.token.split(".");
    const forged = `${Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload!, "base64url").toString()),
        size: 5,
      }),
    ).toString("base64url")}.${signature}`;
    await expect(completeDirectUpload(session, forged)).rejects.toMatchObject({
      status: 400,
      message: "invalid_upload",
    });
    await expect(
      completeDirectUpload(session, "not-a-token"),
    ).rejects.toMatchObject({ status: 400, message: "invalid_upload" });
  });
});
