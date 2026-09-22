import postgres, { type Sql } from "postgres";

let client: Sql | null = null;
let schemaReady: Promise<void> | null = null;

export function db(): Sql {
  if (client) return client;
  const url = process.env.DATABASE_URL?.trim();
  const max = databasePoolMax();
  if (url)
    client = postgres(url, {
      max,
      idle_timeout: 10,
      connect_timeout: 10,
      prepare: false,
    });
  else {
    const host = process.env.SPELLBOOK_DB_HOST?.trim();
    const database = process.env.SPELLBOOK_DB_NAME?.trim();
    const username = process.env.SPELLBOOK_DB_USER?.trim();
    if (!host || !database || !username)
      throw new Error(
        "DATABASE_URL or SPELLBOOK_DB_HOST, SPELLBOOK_DB_NAME and SPELLBOOK_DB_USER are required.",
      );
    client = postgres({
      host,
      port: Number(process.env.SPELLBOOK_DB_PORT ?? 5432),
      database,
      username,
      password: process.env.SPELLBOOK_DB_PASSWORD,
      max,
      idle_timeout: 10,
      connect_timeout: 10,
      prepare: false,
    });
  }
  return client;
}

export function databasePoolMax(
  value = process.env.SPELLBOOK_DB_POOL_MAX,
): number {
  if (value === undefined || value.trim() === "") return 4;
  if (!/^\d+$/.test(value.trim()))
    throw new Error("SPELLBOOK_DB_POOL_MAX must be a positive integer.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 50)
    throw new Error("SPELLBOOK_DB_POOL_MAX must be between 1 and 50.");
  return parsed;
}

export function automaticMigrationsEnabled(
  value = process.env.SPELLBOOK_AUTO_MIGRATE,
): boolean {
  if (value === undefined || value.trim() === "") return true;
  if (value === "1") return true;
  if (value === "0") return false;
  throw new Error("SPELLBOOK_AUTO_MIGRATE must be 0 or 1.");
}

export async function ensureSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  if (!automaticMigrationsEnabled()) {
    schemaReady = Promise.resolve();
    return schemaReady;
  }
  schemaReady = runMigrations().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

export async function runMigrations(): Promise<void> {
  const sql = db();
  await sql.unsafe(`
    create table if not exists spellbook_documents (
      id uuid primary key,
      account_id text not null,
      file_name text not null,
      format_id text not null default 'pptx' check (format_id in ('pptx','docx','spellbook')),
      status text not null check (status in ('processing','ready','editing','candidate_ready','failed')),
      original_version_id uuid,
      current_version_id uuid,
      last_error text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists spellbook_versions (
      id uuid primary key,
      document_id uuid not null references spellbook_documents(id) on delete cascade,
      parent_version_id uuid references spellbook_versions(id),
      kind text not null check (kind in ('original','candidate','approved','abandoned')),
      status text not null check (status in ('processing','ready','failed')),
      document_object text not null,
      graph_object text,
      scan_object text,
      validation_object text,
      document_sha256 text,
      slide_count integer,
      created_at timestamptz not null default now()
    );

    create table if not exists spellbook_edit_requests (
      id uuid primary key,
      document_id uuid not null references spellbook_documents(id) on delete cascade,
      account_id text not null,
      base_version_id uuid not null references spellbook_versions(id),
      candidate_version_id uuid references spellbook_versions(id),
      request_text text not null,
      selected_element_ids jsonb not null default '[]'::jsonb,
      selected_slide_indexes jsonb not null default '[]'::jsonb,
      status text not null check (status in ('planning','patching','reviewing','candidate_ready','approved','rejected','failed')),
      ai_attempts integer not null default 0,
      result_summary text,
      last_error text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists spellbook_jobs (
      id uuid primary key,
      job_type text not null check (job_type in ('scan_render','ai_plan','patch_render','ai_review')),
      document_id uuid not null references spellbook_documents(id) on delete cascade,
      version_id uuid references spellbook_versions(id),
      edit_request_id uuid references spellbook_edit_requests(id),
      status text not null check (status in ('queued','running','succeeded','failed')),
      payload jsonb not null,
      outputs jsonb,
      error text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists spellbook_events (
      id bigserial primary key,
      document_id uuid not null references spellbook_documents(id) on delete cascade,
      event_type text not null,
      payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );

    create index if not exists spellbook_documents_account_created_idx on spellbook_documents(account_id, created_at desc);
    create index if not exists spellbook_versions_document_created_idx on spellbook_versions(document_id, created_at desc);
    create index if not exists spellbook_edits_document_created_idx on spellbook_edit_requests(document_id, created_at desc);
    create index if not exists spellbook_jobs_status_idx on spellbook_jobs(status, created_at);
    create index if not exists spellbook_events_document_id_idx on spellbook_events(document_id, id);

    alter table spellbook_documents add column if not exists format_id text not null default 'pptx';
    alter table spellbook_edit_requests add column if not exists selected_slide_indexes jsonb not null default '[]'::jsonb;
    alter table spellbook_edit_requests add column if not exists input_version_id uuid references spellbook_versions(id);
    alter table spellbook_edit_requests add column if not exists parent_edit_request_id uuid references spellbook_edit_requests(id);
    alter table spellbook_edit_requests add column if not exists assistant_message text;
    alter table spellbook_edit_requests drop constraint if exists spellbook_edit_requests_status_check;
    alter table spellbook_edit_requests add constraint spellbook_edit_requests_status_check check (status in ('planning','patching','reviewing','candidate_ready','approved','rejected','failed','answered'));
    alter table spellbook_jobs add column if not exists dispatched_at timestamptz;
    alter table spellbook_jobs add column if not exists execution_token text;
    alter table spellbook_jobs add column if not exists heartbeat_at timestamptz;

    create table if not exists spellbook_messages (
      id bigserial primary key,
      document_id uuid not null references spellbook_documents(id) on delete cascade,
      edit_request_id uuid not null references spellbook_edit_requests(id) on delete cascade,
      source_key text not null,
      role text not null check (role in ('user','assistant','tool')),
      content text not null,
      status text not null,
      revision integer not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique(edit_request_id, source_key)
    );
    create index if not exists spellbook_messages_document_idx on spellbook_messages(document_id, id);
    alter table spellbook_documents add column if not exists ai_permission jsonb not null default '{"mode":"selection","slideIndexes":[]}'::jsonb;
    alter table spellbook_messages add column if not exists metadata jsonb not null default '{}'::jsonb;
    alter table spellbook_jobs drop constraint if exists spellbook_jobs_job_type_check;
    alter table spellbook_jobs add constraint spellbook_jobs_job_type_check check (job_type in ('scan_render','ai_plan','patch_render','ai_review','native_turn'));
    create table if not exists spellbook_assets (
      id uuid primary key,
      document_id uuid not null references spellbook_documents(id) on delete cascade,
      file_name text not null,
      object_name text not null,
      content_type text not null,
      width integer not null,
      height integer not null,
      created_at timestamptz not null default now()
    );
    create index if not exists spellbook_assets_document_idx on spellbook_assets(document_id);

    create table if not exists spellbook_native_sessions (
      id uuid primary key,
      document_id uuid not null references spellbook_documents(id) on delete cascade,
      account_id text not null,
      account_email text,
      working_version_id uuid not null references spellbook_versions(id),
      working_sha256 text,
      editor_mode text not null default 'wopi' check (editor_mode in ('wopi','browser')),
      status text not null check (status in ('active','validating','failed','closed')),
      wopi_lock text,
      lock_updated_at timestamptz,
      lock_expires_at timestamptz,
      save_revision integer not null default 0,
      last_error text,
      last_seen_at timestamptz not null default now(),
      expires_at timestamptz not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique(document_id, account_id)
    );
    create index if not exists spellbook_native_sessions_expiry_idx on spellbook_native_sessions(expires_at);
    alter table spellbook_native_sessions add column if not exists working_sha256 text;
    alter table spellbook_native_sessions add column if not exists account_email text;
    alter table spellbook_native_sessions add column if not exists editor_mode text not null default 'wopi';
    alter table spellbook_native_sessions add column if not exists lock_expires_at timestamptz;
    alter table spellbook_native_sessions drop constraint if exists spellbook_native_sessions_editor_mode_check;
    alter table spellbook_native_sessions add constraint spellbook_native_sessions_editor_mode_check check (editor_mode in ('wopi','browser'));

    create table if not exists spellbook_native_turns (
      id uuid primary key,
      session_id uuid not null references spellbook_native_sessions(id) on delete cascade,
      document_id uuid not null references spellbook_documents(id) on delete cascade,
      account_id text not null,
      job_id uuid not null unique references spellbook_jobs(id) on delete cascade,
      request_text text not null,
      permission_mode text not null check (permission_mode in ('read_only','selection','slides','document')),
      model_settings jsonb,
      status text not null check (status in ('queued','running','completed','failed','cancelled')),
      assistant_text text,
      changed boolean not null default false,
      reviewed boolean not null default false,
      last_error text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index if not exists spellbook_native_turns_session_idx on spellbook_native_turns(session_id, created_at);
    create unique index if not exists spellbook_native_turns_one_active_idx
      on spellbook_native_turns(session_id) where status in ('queued','running');

    create table if not exists spellbook_native_tasks (
      id uuid primary key,
      session_id uuid not null references spellbook_native_sessions(id) on delete cascade,
      turn_id uuid not null references spellbook_native_turns(id) on delete cascade,
      request jsonb not null,
      status text not null check (status in ('queued','delivered','completed','failed','expired')),
      result jsonb,
      error text,
      delivery_count integer not null default 0,
      save_revision_at_create integer not null default 0,
      delivered_at timestamptz,
      expires_at timestamptz not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    alter table spellbook_native_tasks add column if not exists save_revision_at_create integer not null default 0;
    create index if not exists spellbook_native_tasks_delivery_idx on spellbook_native_tasks(session_id, status, created_at);

    create table if not exists spellbook_native_events (
      id bigserial primary key,
      session_id uuid not null references spellbook_native_sessions(id) on delete cascade,
      turn_id uuid references spellbook_native_turns(id) on delete cascade,
      event_type text not null,
      payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
    create index if not exists spellbook_native_events_session_idx on spellbook_native_events(session_id, id);
    alter table spellbook_native_turns add column if not exists summary jsonb;
    alter table spellbook_versions add column if not exists restored_from_version_id uuid references spellbook_versions(id);
    alter table spellbook_versions add column if not exists editor_modified boolean;
    alter table spellbook_versions add column if not exists document_bytes bigint;
    alter table spellbook_versions add column if not exists undone_turn_id uuid;
    alter table spellbook_native_turns add column if not exists undone_at timestamptz;
    alter table spellbook_native_sessions add column if not exists pending_undo_turn_id uuid;
    alter table spellbook_native_sessions add column if not exists pending_undo_at timestamptz;
    alter table spellbook_documents add column if not exists failure_code text;
    create table if not exists spellbook_editor_engines (
      editor_mode text primary key check (editor_mode in ('wopi','browser')),
      patch_level text,
      supported_operations jsonb not null default '[]'::jsonb,
      seen_at timestamptz not null default now()
    );
    create table if not exists spellbook_account_providers (
      account_id text not null,
      provider text not null,
      api_key_encrypted text,
      is_active boolean not null default false,
      models_cache jsonb,
      custom_model text,
      custom_base_url text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (account_id, provider)
    );
    alter table spellbook_account_providers add column if not exists models_cache jsonb;
    alter table spellbook_account_providers add column if not exists custom_model text;
    alter table spellbook_account_providers add column if not exists custom_base_url text;
  `);
}

export async function closeDbForTests(): Promise<void> {
  if (client) await client.end({ timeout: 1 });
  client = null;
  schemaReady = null;
}

export const closeDb = closeDbForTests;
