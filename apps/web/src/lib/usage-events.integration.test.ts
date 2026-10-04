import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isolatedPostgresTestUrl } from "./postgres-test-schema";
import { closeDb, db, ensureSchema } from "./db";
import { deleteAccountUsageEvents, recordUsageEvent } from "./usage-events";

const enabled = process.env.SPELLBOOK_VERSION_INTEGRATION === "1";
const testSchema = `spellbook_usage_${randomUUID().replaceAll("-", "")}`;
const metricsSql = readFileSync(
  path.resolve(__dirname, "../../scripts/usage-metrics.sql"),
  "utf8",
);

beforeAll(async () => {
  if (!enabled) return;
  vi.stubEnv("DATABASE_URL", await isolatedPostgresTestUrl(testSchema));
  await ensureSchema();
});
afterAll(async () => {
  if (!enabled) return;
  await db().unsafe(`drop schema if exists "${testSchema}" cascade`);
  await closeDb();
  vi.unstubAllEnvs();
});

async function metrics(from: string, to: string, today: string) {
  const [row] = await db().unsafe(metricsSql, [from, to, today]);
  return row!.metrics as Record<string, any>;
}

async function event(
  accountId: string,
  type: string,
  day: string,
  documentId: string | null = null,
  detail: Record<string, unknown> = {},
) {
  await db()`
    insert into spellbook_usage_events (account_id, event_type, document_id, day, detail)
    values (${accountId}, ${type}, ${documentId}, ${day}, ${db().json(detail as never)})
  `;
}

describe.skipIf(!enabled)("usage events", () => {
  it("records one visit per account per day and the first real edit once", async () => {
    const account = `usage-${randomUUID()}`;
    const document = randomUUID();
    await recordUsageEvent(account, { type: "visit" });
    await recordUsageEvent(account, { type: "visit" });
    await recordUsageEvent(account, {
      type: "save_accepted",
      documentId: document,
      unchanged: true,
    });
    await recordUsageEvent(account, {
      type: "save_accepted",
      documentId: document,
      unchanged: false,
    });
    await recordUsageEvent(account, {
      type: "save_accepted",
      documentId: document,
      unchanged: false,
    });
    await recordUsageEvent(account, {
      type: "save_rejected",
      documentId: document,
      reason: "Error: slide text that must not be stored",
    });
    const rows = await db()`
      select event_type, detail from spellbook_usage_events
      where account_id=${account} order by id
    `;
    expect(rows.map((row) => row.event_type)).toEqual([
      "visit",
      "save_accepted",
      "save_accepted",
      "first_edit",
      "save_accepted",
      "save_rejected",
    ]);
    expect(rows.at(-1)!.detail).toEqual({ reason: "other" });
    expect(await deleteAccountUsageEvents(account)).toBe(6);
  });

  it("ignores events that do not name a real document id", async () => {
    const account = `usage-${randomUUID()}`;
    await recordUsageEvent(account, {
      type: "download",
      documentId: "not-a-document",
      source: "current",
    });
    const [count] =
      await db()`select count(*)::int as n from spellbook_usage_events where account_id=${account}`;
    expect(count!.n).toBe(0);
  });

  it("records every AI request outcome with its provider", async () => {
    const account = `usage-${randomUUID()}`;
    const documentId = randomUUID();
    const versionId = randomUUID();
    const sessionId = randomUUID();
    const sql = db();
    await sql`insert into spellbook_documents (id, account_id, file_name, status)
      values (${documentId}, ${account}, 'deck.pptx', 'ready')`;
    await sql`insert into spellbook_versions (id, document_id, kind, status, document_object)
      values (${versionId}, ${documentId}, 'original', 'ready', 'x')`;
    await sql`insert into spellbook_native_sessions (id, document_id, account_id, working_version_id, status, expires_at)
      values (${sessionId}, ${documentId}, ${account}, ${versionId}, 'active', now() + interval '1 hour')`;
    const outcomes = [
      [
        "completed",
        { provider: "gemini_api", model: "m", effort: "low" },
        null,
      ],
      [
        "failed",
        { provider: "anthropic_api", model: "m", effort: "low" },
        "ai_rate_limited",
      ],
      ["failed", null, "모델이 응답하지 않았어요."],
      ["cancelled", null, null],
    ] as const;
    for (const [status, settings, error] of outcomes) {
      const jobId = randomUUID();
      const turnId = randomUUID();
      await sql`insert into spellbook_jobs (id, job_type, document_id, status, payload)
        values (${jobId}, 'native_turn', ${documentId}, 'queued', '{}'::jsonb)`;
      await sql`insert into spellbook_native_turns
        (id, session_id, document_id, account_id, job_id, request_text, permission_mode, model_settings, status)
        values (${turnId}, ${sessionId}, ${documentId}, ${account}, ${jobId}, 'secret request', 'selection',
          ${settings ? sql.json(settings as never) : null}, 'queued')`;
      await sql`update spellbook_native_turns set status='running' where id=${turnId}`;
      await sql`update spellbook_native_turns set status=${status}, last_error=${error} where id=${turnId}`;
      // A repeated write of the same state is not a second outcome.
      await sql`update spellbook_native_turns set status=${status} where id=${turnId}`;
    }
    const rows = await sql`
      select detail from spellbook_usage_events
      where account_id=${account} and event_type='ai_turn' order by id
    `;
    expect(rows.map((row) => row.detail)).toEqual([
      {
        outcome: "completed",
        provider: "gemini_api",
        model: "m",
        changed: false,
        reason: null,
      },
      {
        outcome: "failed",
        provider: "anthropic_api",
        model: "m",
        changed: false,
        reason: "ai_rate_limited",
      },
      {
        outcome: "failed",
        provider: "default",
        model: "",
        changed: false,
        reason: "other",
      },
      {
        outcome: "cancelled",
        provider: "default",
        model: "",
        changed: false,
        reason: null,
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain("secret request");
    await sql`delete from spellbook_usage_events where account_id=${account}`;
  });

  it("computes activation, edit success, AI success and return visits", async () => {
    await db()`delete from spellbook_usage_events`;
    const doc = () => randomUUID();
    // a: new on 10-01, edits and downloads, back on day 1 and day 7.
    await event("a", "visit", "2026-10-01");
    await event("a", "visit", "2026-10-02");
    await event("a", "visit", "2026-10-08");
    const aDoc = doc();
    await event("a", "upload", "2026-10-01", aDoc);
    await event("a", "save_accepted", "2026-10-01", aDoc, { unchanged: false });
    await event("a", "first_edit", "2026-10-01", aDoc);
    await event("a", "download", "2026-10-01", aDoc, { source: "current" });
    // b: new on 10-01, a save failed, never edited successfully, back on day 3.
    await event("b", "visit", "2026-10-01");
    await event("b", "visit", "2026-10-04");
    const bDoc = doc();
    await event("b", "save_accepted", "2026-10-01", bDoc, { unchanged: false });
    await event("b", "save_rejected", "2026-10-01", bDoc, {
      reason: "browser_revision_changed",
    });
    await event("b", "save_failed_client", "2026-10-01", bDoc, {
      stage: "browser",
    });
    // c: first seen before the period; not a new account.
    await event("c", "visit", "2026-09-20");
    await event("c", "visit", "2026-10-03");
    // d: new on 10-05; day 7 has not happened yet.
    await event("d", "visit", "2026-10-05");
    await event("d", "save_accepted", "2026-10-09", doc(), {
      unchanged: false,
    });
    await event("d", "first_edit", "2026-10-09");
    await event("a", "ai_turn", "2026-10-01", aDoc, {
      outcome: "completed",
      provider: "codex",
    });
    await event("a", "ai_turn", "2026-10-01", aDoc, {
      outcome: "failed",
      provider: "codex",
      reason: "ai_rate_limited",
    });
    await event("b", "ai_turn", "2026-10-01", bDoc, {
      outcome: "cancelled",
      provider: "codex",
    });
    await event("b", "ai_turn", "2026-10-01", bDoc, {
      outcome: "completed",
      provider: "gemini_api",
    });

    const result = await metrics("2026-10-01", "2026-10-10", "2026-10-10");
    expect(result.dailyActive).toEqual([
      { day: "2026-10-01", accounts: 2 },
      { day: "2026-10-02", accounts: 1 },
      { day: "2026-10-03", accounts: 1 },
      { day: "2026-10-04", accounts: 1 },
      { day: "2026-10-05", accounts: 1 },
      { day: "2026-10-08", accounts: 1 },
    ]);
    expect(result.activation).toEqual({
      newAccounts: 3,
      editedWithin7Days: 2,
      downloadedWithin7Days: 1,
    });
    expect(result.retention).toEqual({
      d1Eligible: 3,
      d1Returned: 1,
      d7Eligible: 2,
      d7Returned: 1,
      week1Returned: 2,
    });
    expect(result.edits).toMatchObject({
      editGroups: 3,
      successfulGroups: 2,
      savesRejected: 1,
      clientReportedFailures: 1,
      uploads: 1,
      downloads: 1,
    });
    expect(result.ai).toEqual([
      { provider: "codex", completed: 1, failed: 1, cancelled: 1 },
      { provider: "gemini_api", completed: 1, failed: 0, cancelled: 0 },
    ]);
    expect(result.aiFailureReasons).toEqual([
      { provider: "codex", reason: "ai_rate_limited", count: 1 },
    ]);
  });
});
