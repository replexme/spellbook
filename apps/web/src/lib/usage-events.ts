import type { Sql } from "postgres";

import { db, ensureSchema } from "./db";
import { USAGE_EVENT_TYPES } from "./usage-events-schema";

/*
 * Product usage, kept to what the edit success, AI success, activation and
 * return-visit numbers need: who (the account id the documents already use),
 * what kind of action, which document, when, and a reason code. Never file
 * names, document content, AI requests or email addresses. Rows are removed
 * with the account (see the managed account deletion adapter).
 */

export type UsageEvent =
  | { type: "visit" }
  | { type: "upload"; documentId: string }
  | { type: "download"; documentId: string; source: string }
  | { type: "save_accepted"; documentId: string; unchanged: boolean }
  | { type: "save_rejected"; documentId: string; reason: string }
  | { type: "save_failed_client"; documentId: string; stage: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[a-z][a-z0-9_]{0,79}$/;

/** Only short reason codes are stored; free text becomes "other". */
export function usageReason(value: unknown): string {
  return typeof value === "string" && CODE.test(value) ? value : "other";
}

/**
 * Records one usage event. Measurement must never break the action it
 * measures, so failures are logged and swallowed.
 */
export async function recordUsageEvent(
  accountId: string,
  event: UsageEvent,
): Promise<void> {
  try {
    if (!accountId) return;
    const documentId =
      "documentId" in event && UUID.test(event.documentId)
        ? event.documentId
        : null;
    if ("documentId" in event && !documentId) return;
    await ensureSchema();
    const sql = db();
    switch (event.type) {
      case "visit":
        await sql`
          insert into spellbook_usage_events (account_id, event_type)
          values (${accountId}, 'visit')
          on conflict (account_id, day) where event_type='visit' do nothing
        `;
        return;
      case "upload":
        await insert(sql, accountId, "upload", documentId, {});
        return;
      case "download":
        await insert(sql, accountId, "download", documentId, {
          source: usageReason(event.source),
        });
        return;
      case "save_accepted":
        await insert(sql, accountId, "save_accepted", documentId, {
          unchanged: event.unchanged,
        });
        if (!event.unchanged)
          await sql`
            insert into spellbook_usage_events (account_id, event_type, document_id)
            values (${accountId}, 'first_edit', ${documentId})
            on conflict (account_id) where event_type='first_edit' do nothing
          `;
        return;
      case "save_rejected":
        await insert(sql, accountId, "save_rejected", documentId, {
          reason: usageReason(event.reason),
        });
        return;
      case "save_failed_client":
        await insert(sql, accountId, "save_failed_client", documentId, {
          stage: usageReason(event.stage),
        });
        return;
    }
  } catch (error) {
    console.warn(
      `usage event not recorded: ${event.type}`,
      error instanceof Error ? error.message : "unknown",
    );
  }
}

async function insert(
  sql: Sql,
  accountId: string,
  type: (typeof USAGE_EVENT_TYPES)[number],
  documentId: string | null,
  detail: Record<string, string | boolean>,
) {
  await sql`
    insert into spellbook_usage_events (account_id, event_type, document_id, detail)
    values (${accountId}, ${type}, ${documentId}, ${sql.json(detail)})
  `;
}

/** Deletes an account's usage rows; part of account deletion. */
export async function deleteAccountUsageEvents(
  accountId: string,
): Promise<number> {
  await ensureSchema();
  const rows = await db()`
    delete from spellbook_usage_events where account_id=${accountId} returning id
  `;
  return rows.length;
}
