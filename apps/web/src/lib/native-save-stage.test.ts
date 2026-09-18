import { describe, expect, it, vi } from "vitest";
import type { TransactionSql } from "postgres";

const loadNativeSaveChangePolicy = vi.hoisted(() =>
  vi.fn(async () => ({
    origin: "ai",
    taskIds: ["reviewed-task"],
    budget: { contractVersion: "1.0", allowedCategories: ["slide_parts"] },
  })),
);
vi.mock("./native-change-budget", () => ({ loadNativeSaveChangePolicy }));
vi.mock("./runtime-urls", () => ({
  internalAppBaseUrl: () => "https://spellbook.test",
}));
vi.mock("./storage", () => ({ storageNamespace: () => "test-namespace" }));

import { stageNativeSave } from "./native-save-stage";

describe("shared native save staging", () => {
  it("stages one version, one scan job and one session advance under the same policy", async () => {
    const statements: Array<{ text: string; values: unknown[] }> = [];
    const sql = Object.assign(
      async (parts: TemplateStringsArray, ...values: unknown[]) => {
        statements.push({ text: parts.join("?"), values });
        return [];
      },
      { json: (value: unknown) => value },
    ) as unknown as TransactionSql;
    const payload = await stageNativeSave(sql, {
      sessionId: "session-1",
      documentId: "document-1",
      parentVersionId: "version-1",
      versionId: "version-2",
      jobId: "job-1",
      object: "versions/version-2/document.pptx",
      outputPrefix: "versions/version-2/render",
      digest: "a".repeat(64),
      preservationObject: "versions/version-1/document.pptx",
      saveRevision: 3,
    });

    expect(loadNativeSaveChangePolicy).toHaveBeenCalledWith(
      sql,
      "session-1",
      3,
    );
    expect(payload).toMatchObject({
      inputObject: "versions/version-2/document.pptx",
      baselineInputObject: "versions/version-1/document.pptx",
      nativeSessionId: "session-1",
      changeOrigin: "ai",
      changeTaskIds: ["reviewed-task"],
    });
    expect(statements).toHaveLength(4);
    expect(statements.map(({ text }) => text)).toEqual([
      expect.stringContaining("pending_undo_turn_id"),
      expect.stringContaining("insert into spellbook_versions"),
      expect.stringContaining("insert into spellbook_jobs"),
      expect.stringContaining("update spellbook_native_sessions"),
    ]);
    expect(statements[1]?.values).toContain("version-1");
    expect(statements[1]?.values.at(-1)).toBeNull();
    expect(statements[2]?.values).toContain(payload);
    expect(statements[3]?.values).toContain("session-1");
    expect(statements[3]?.text).toContain("pending_undo_turn_id=null");
  });

  it("names the save right after an undo as that undo", async () => {
    const statements: Array<{ text: string; values: unknown[] }> = [];
    const sql = Object.assign(
      async (parts: TemplateStringsArray, ...values: unknown[]) => {
        const text = parts.join("?");
        statements.push({ text, values });
        return text.includes("select pending_undo_turn_id") ? [{ pending_undo_turn_id: "turn-7" }] : [];
      },
      { json: (value: unknown) => value },
    ) as unknown as TransactionSql;
    await stageNativeSave(sql, {
      sessionId: "session-1",
      documentId: "document-1",
      parentVersionId: "version-1",
      versionId: "version-2",
      jobId: "job-1",
      object: "versions/version-2/document.pptx",
      outputPrefix: "versions/version-2/render",
      digest: "a".repeat(64),
      preservationObject: "versions/version-1/document.pptx",
      saveRevision: 3,
      bytes: 1234,
    });
    const insert = statements.find(({ text }) => text.includes("insert into spellbook_versions"));
    expect(insert?.values.slice(-2)).toEqual([1234, "turn-7"]);
  });
});
