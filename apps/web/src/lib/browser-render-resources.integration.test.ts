import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { db, ensureSchema } from "./db";
import { isolatedPostgresTestUrl } from "./postgres-test-schema";
import { createSessionToken, SESSION_COOKIE } from "./auth";
import { accountPrefix, putObject, deleteDocumentObjects } from "./storage";
import { browserDocumentSource } from "./browser-session";
import { GET } from "../app/api/documents/[id]/browser/render-resources/route";
import type { Session } from "./models";

const configured = Boolean(process.env.DATABASE_URL);
const schema = "render_resources_" + randomUUID().replaceAll("-", "");
const documentId = randomUUID(),
  versionId = randomUUID(),
  sessionId = randomUUID();
const owner: Session = {
  accountId: "render-resource-owner",
  email: "owner@example.test",
  admin: true,
  token: "",
};
const other: Session = {
  accountId: "render-resource-other",
  email: "other@example.test",
  admin: true,
  token: "",
};
const image = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);
const imageSha = createHash("sha256").update(image).digest("hex");
let directory: string,
  administratorUrl: string,
  sourceSha: string,
  revision: string;
const headers = (session: Session | null = owner, match = revision) => ({
  ...(session
    ? { cookie: `${SESSION_COOKIE}=${createSessionToken(session)}` }
    : {}),
  ...(match ? { "if-match": match } : {}),
});
const read = (
  session: Session | null = owner,
  match = revision,
  sha256: string | null = null,
) =>
  GET(
    new Request(
      "http://localhost/api/resource" + (sha256 ? "?sha256=" + sha256 : ""),
      { headers: headers(session, match) },
    ),
    { params: Promise.resolve({ id: documentId }) },
  );

describe.skipIf(!configured)(
  "owned browser render resources with actual PostgreSQL, session validation and disk storage",
  () => {
    beforeAll(async () => {
      administratorUrl = process.env.DATABASE_URL!;
      vi.stubEnv("DATABASE_URL", await isolatedPostgresTestUrl(schema));
      vi.stubEnv(
        "SPELLBOOK_SESSION_SECRET",
        "test-resource-session-secret-" + randomUUID(),
      );
      directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "spellbook-render-resource-api-"),
      );
      vi.stubEnv("SPELLBOOK_DATA_DIR", directory);
      await ensureSchema();
      const source = await fs.readFile(
        new URL(
          "../../../../eval/public/downloads/ox-linked-picture.pptx",
          import.meta.url,
        ),
      );
      sourceSha = createHash("sha256").update(source).digest("hex");
      revision = `"browser:${versionId}:${sourceSha}"`;
      const documentObject =
        accountPrefix(owner.accountId, documentId) +
        `/versions/${versionId}/document.pptx`;
      await putObject(
        documentObject,
        source,
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      );
      await db()`insert into spellbook_documents(id,account_id,file_name,status,current_version_id,original_version_id)values(${documentId},${owner.accountId},'linked.pptx','ready',${versionId},${versionId})`;
      await db()`insert into spellbook_versions(id,document_id,kind,status,document_object,document_sha256,document_bytes)values(${versionId},${documentId},'original','ready',${documentObject},${sourceSha},${source.length})`;
      await db()`insert into spellbook_native_sessions(id,document_id,account_id,account_email,working_version_id,working_sha256,editor_mode,status,expires_at)values(${sessionId},${documentId},${owner.accountId},${owner.email},${versionId},${sourceSha},'browser','active',${new Date(Date.now() + 600_000)})`;
      const link = {
        ownerPart: "ppt/slides/slide1.xml",
        relationshipPart: "ppt/slides/_rels/slide1.xml.rels",
        relationshipId: "rId2",
        url: "http://www.google.com/intl/en/images/logo.gif",
        consumers: 1,
      };
      const linkIdentity = createHash("sha256")
        .update(
          JSON.stringify([
            link.ownerPart,
            link.relationshipPart,
            link.relationshipId,
            link.url,
          ]),
        )
        .digest("hex");
      const prefix =
        accountPrefix(owner.accountId, documentId) + "/render-resources";
      await putObject(prefix + "/blobs/" + imageSha, image, "image/gif");
      await putObject(
        prefix + "/sources/" + sourceSha + ".json",
        Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            accountId: owner.accountId,
            documentId,
            sourceSha256: sourceSha,
            images: [
              {
                ...link,
                sha256: imageSha,
                byteLength: image.length,
                width: 1,
                height: 1,
                contentType: "image/gif",
                extension: "gif",
                linkIdentity,
              },
            ],
            skipped: [],
          }),
        ),
        "application/json",
      );
    }, 30_000);
    afterAll(async () => {
      await db().end();
      const administrator = postgres(administratorUrl, {
        max: 1,
        prepare: false,
      });
      try {
        await administrator.unsafe(`drop schema if exists "${schema}" cascade`);
      } finally {
        await administrator.end();
      }
      await fs.rm(directory, { recursive: true, force: true });
      vi.unstubAllEnvs();
    });
    it("file source and image index have the same exact owned revision", async () => {
      const source = await browserDocumentSource(owner, documentId);
      revision = source.revision;
      expect(source.renderResources?.sourceSha256).toBe(sourceSha);
      const response = await read();
      expect(response.status).toBe(200);
      expect(response.headers.get("etag")).toBe(revision);
      expect((await response.json()).manifest.images[0].sha256).toBe(imageSha);
    });
    it("serves only the admitted image bytes with private no-store headers", async () => {
      const response = await read(owner, revision, imageSha);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("content-type")).toBe("image/gif");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(image);
    });
    it("does not admit an anonymous or damaged login", async () => {
      expect((await read(null)).status).toBe(401);
      const response = await GET(
        new Request("http://localhost/api/resource", {
          headers: {
            cookie: `${SESSION_COOKIE}=invalid`,
            "if-match": revision,
          },
        }),
        { params: Promise.resolve({ id: documentId }) },
      );
      expect(response.status).toBe(401);
    });
    it("another valid account cannot read an owner's known image hash", async () => {
      const response = await read(other, revision, imageSha);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "browser_session_not_active",
      });
    });
    it("requires a matching revision and refuses stale requests", async () => {
      expect((await read(owner, "")).status).toBe(428);
      expect((await read(owner, '"old:revision"', imageSha)).status).toBe(409);
    });
    it("cannot turn the endpoint into a remote URL fetch or arbitrary blob reader", async () => {
      expect(
        (await read(owner, revision, "http://example.test/image.gif")).status,
      ).toBe(400);
      expect((await read(owner, revision, "f".repeat(64))).status).toBe(404);
    });
    it("rejects a closed active document before reading its images", async () => {
      await db()`update spellbook_native_sessions set status='closed' where id=${sessionId}`;
      try {
        expect((await read(owner, revision, imageSha)).status).toBe(409);
      } finally {
        await db()`update spellbook_native_sessions set status='active' where id=${sessionId}`;
      }
    });
    it("existing document storage deletion removes the private resource closure", async () => {
      await deleteDocumentObjects(owner.accountId, documentId);
      const response = await read(owner, revision, imageSha);
      expect(response.status).not.toBe(200);
    });
  },
);
