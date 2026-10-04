import type { Sql } from "postgres";

/** The kinds of usage the product records (see usage-events.ts). */
export const USAGE_EVENT_TYPES = [
  "visit",
  "upload",
  "first_edit",
  "download",
  "save_accepted",
  "save_rejected",
  "save_failed_client",
  "ai_turn",
] as const;

export async function runUsageEventMigrations(sql: Sql): Promise<void> {
  await sql.unsafe(`
    create table if not exists spellbook_usage_events (
      id bigserial primary key,
      account_id text not null,
      event_type text not null check (event_type in (${USAGE_EVENT_TYPES.map((type) => `'${type}'`).join(",")})),
      document_id uuid,
      day date not null default ((now() at time zone 'Asia/Seoul')::date),
      detail jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
    create unique index if not exists spellbook_usage_visit_once_idx
      on spellbook_usage_events(account_id, day) where event_type='visit';
    create unique index if not exists spellbook_usage_first_edit_once_idx
      on spellbook_usage_events(account_id) where event_type='first_edit';
    create index if not exists spellbook_usage_type_day_idx
      on spellbook_usage_events(event_type, day);
    create index if not exists spellbook_usage_account_idx
      on spellbook_usage_events(account_id);

    -- Every AI request ends in exactly one of these states, whichever code
    -- path ends it (worker callback, browser key, cancel, lease expiry), so
    -- the outcome is recorded where the state changes. A failure to record
    -- never blocks the request itself.
    create or replace function spellbook_record_ai_turn_usage() returns trigger
      language plpgsql as $$
      begin
        begin
          insert into spellbook_usage_events (account_id, event_type, document_id, detail)
          values (NEW.account_id, 'ai_turn', NEW.document_id, jsonb_build_object(
            'outcome', NEW.status,
            'provider', left(coalesce(NEW.model_settings->>'provider', 'default'), 40),
            'model', left(coalesce(NEW.model_settings->>'model', ''), 80),
            'changed', NEW.changed,
            'reason', case
              when NEW.status = 'failed' and NEW.last_error ~ '^[a-z][a-z0-9_]{0,79}$'
                then NEW.last_error
              when NEW.status = 'failed' then 'other'
              else null end));
        exception when others then
          null;
        end;
        return NEW;
      end;
    $$;
    drop trigger if exists spellbook_native_turns_usage on spellbook_native_turns;
    create trigger spellbook_native_turns_usage
      after update of status on spellbook_native_turns
      for each row when (
        OLD.status is distinct from NEW.status and
        NEW.status in ('completed','failed','cancelled')
      ) execute function spellbook_record_ai_turn_usage();
  `);
}
