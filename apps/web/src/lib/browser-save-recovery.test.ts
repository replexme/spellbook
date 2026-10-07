import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const row = {
    id: "session",
    working_version_id: "original",
    working_sha256: "a".repeat(64),
    status: "active",
    editor_mode: "browser",
    wopi_lock: null,
    save_revision: 0,
    preservation_object: "original.pptx",
  };
  const sql: any = Object.assign(
    vi.fn(async () => [row]),
    { json: (x: unknown) => x },
  );
  sql.begin = async (fn: any) => fn(sql);
  return {
    sql,
    row,
    policy: vi.fn(),
    target: vi.fn(),
    digest: vi.fn(),
    move: vi.fn(),
    discard: vi.fn(),
    stage: vi.fn(),
    dispatch: vi.fn(),
  };
});
vi.mock("./db", () => ({ db: () => mocks.sql, ensureSchema: async () => {} }));
vi.mock("./storage", () => ({
  accountPrefix: () => "accounts/test/documents/doc",
  directWriteTarget: mocks.target,
  objectDigest: mocks.digest,
  moveObject: mocks.move,
  deleteObject: mocks.discard,
}));
vi.mock("./storage-usage", () => ({ assertStorageAvailable: async () => {} }));
vi.mock("./native-save-stage", () => ({
  stageNativeSave: mocks.stage,
  dispatchNativeSave: mocks.dispatch,
}));
vi.mock("./native-change-budget", () => ({
  loadNativeSaveChangePolicy: mocks.policy,
}));
vi.mock("./runtime-urls", () => ({
  publicAppBaseUrl: () => "https://spellbook.test",
}));
vi.mock("./http", () => ({
  HttpError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { startBrowserSave, completeBrowserSave } from "./browser-session";
import { signClaims, verifiedClaims } from "./signed-claims";
const session = {
  accountId: "owner",
  email: "owner@example.test",
  name: "Owner",
  admin: true as const,
  token: "local-test",
};
const origin = "https://spellbook.test";
const request = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(origin + "/api/documents/doc/browser/saves", {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv(
    "SPELLBOOK_WOPI_SECRET",
    "local-test-secret-with-more-than-32-bytes",
  );
  mocks.policy.mockResolvedValue({ origin: "human" });
  mocks.target.mockResolvedValue({
    url: "https://storage.test/incoming",
    headers: {},
  });
  mocks.digest.mockResolvedValue({
    size: 5,
    head: Buffer.from([80, 75]),
    sha256: "b".repeat(64),
  });
  mocks.stage.mockResolvedValue({ jobId: "job" });
  mocks.discard.mockResolvedValue(undefined);
});
it("rejects pending review before issuing an upload, with a recoverable 409", async () => {
  mocks.policy.mockRejectedValue(new Error("native_ai_change_review_pending"));
  await expect(
    startBrowserSave(
      session,
      "doc",
      request({ size: 5 }, { "if-match": '"original:' + "a".repeat(64) + '"' }),
    ),
  ).rejects.toMatchObject({
    status: 409,
    message: "native_ai_change_review_pending",
  });
  expect(mocks.target).not.toHaveBeenCalled();
});
it("binds explicit human retention into signed claims and the locked validation stage", async () => {
  const started = await startBrowserSave(
    session,
    "doc",
    request(
      { size: 5 },
      {
        "if-match": '"original:' + "a".repeat(64) + '"',
        "x-spellbook-save-intent": "human_confirmed",
      },
    ),
  );
  expect(started.direct).toBe(true);
  if (!started.direct) throw Error("missing direct target");
  await completeBrowserSave(session, "doc", request({ token: started.token }));
  expect(mocks.stage.mock.calls[0][1].humanConfirmed).toBe(true);
  expect(mocks.stage.mock.calls[0][1].preservationObject).toBe("original.pptx");
  expect(mocks.dispatch).toHaveBeenCalledOnce();
});
it("does not accept a forged confirmation or a token for another account", async () => {
  const started = await startBrowserSave(
    session,
    "doc",
    request({ size: 5 }, { "if-match": '"original:' + "a".repeat(64) + '"' }),
  );
  if (!started.direct) throw Error("missing direct target");
  await completeBrowserSave(
    session,
    "doc",
    request({ token: started.token, humanConfirmed: true }),
  );
  expect(mocks.stage.mock.calls[0][1].humanConfirmed).toBe(false);
  await expect(
    completeBrowserSave(
      { ...session, accountId: "another" },
      "doc",
      request({ token: started.token }),
    ),
  ).rejects.toMatchObject({ status: 400, message: "invalid_browser_save" });
  const claims: any = verifiedClaims(
    "spellbook-browser-save-v1",
    started.token,
  );
  expect(claims).not.toBeNull();
  const forged =
    Buffer.from(JSON.stringify({ ...claims, humanConfirmed: true })).toString(
      "base64url",
    ) +
    "." +
    started.token.split(".")[1];
  await expect(
    completeBrowserSave(session, "doc", request({ token: forged })),
  ).rejects.toMatchObject({ status: 400, message: "invalid_browser_save" });
});
it("still refuses a malformed stored package and removes it", async () => {
  const token = signClaims("spellbook-browser-save-v1", {
    version: 1,
    accountId: "owner",
    documentId: "doc",
    versionId: "saved",
    expectedRevision: '"original:' + "a".repeat(64) + '"',
    size: 5,
    expiresAt: Date.now() + 60000,
    humanConfirmed: true,
  });
  mocks.digest.mockResolvedValue({
    size: 5,
    head: Buffer.from([0, 0]),
    sha256: "b".repeat(64),
  });
  await expect(
    completeBrowserSave(session, "doc", request({ token })),
  ).rejects.toMatchObject({ status: 400, message: "invalid_document_package" });
  expect(mocks.discard).toHaveBeenCalledOnce();
  expect(mocks.stage).not.toHaveBeenCalled();
});
