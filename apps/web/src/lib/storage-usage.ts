import { accountPlan, type AccountPlan } from "./account-plan";
import { db, ensureSchema } from "./db";
import { HttpError } from "./http";
import type { Session } from "./models";
import { accountPrefix, prefixBytes } from "./storage";
import {
  storageLimits,
  storageQuotaProblem,
  type StorageLimits,
  type StorageUsage,
} from "./storage-quota";

// Documents never measured yet (stored before measuring existed) are
// measured one per request: listing a document with hundreds of versions
// takes seconds, and this runs inside imports and saves.
const MEASURE_PER_REQUEST = 1;

/** Measures what one document keeps in storage and records it. */
export async function measureDocumentStorage(
  accountId: string,
  documentId: string,
): Promise<number> {
  const bytes = await prefixBytes(`${accountPrefix(accountId, documentId)}/`);
  await db()`
    update spellbook_documents set stored_bytes=${bytes}, stored_bytes_at=now()
    where id=${documentId} and account_id=${accountId}
  `;
  return bytes;
}

/**
 * What an account keeps: its file count and stored bytes. A document not
 * measured yet counts with the file sizes the database knows, a lower bound
 * until it is measured.
 */
export async function accountStorageUsage(
  accountId: string,
): Promise<StorageUsage> {
  await ensureSchema();
  const unmeasured = await db()`
    select id from spellbook_documents
    where account_id=${accountId} and stored_bytes is null
    order by created_at limit ${MEASURE_PER_REQUEST}
  `;
  for (const row of unmeasured)
    await measureDocumentStorage(accountId, row.id).catch(() => undefined);
  const [usage] = await db()`
    select count(*)::bigint as documents,
      coalesce(sum(coalesce(d.stored_bytes, (
        select coalesce(sum(v.document_bytes), 0) from spellbook_versions v where v.document_id=d.id
      ))), 0)::bigint as bytes
    from spellbook_documents d
    where d.account_id=${accountId}
  `;
  return { documents: Number(usage.documents), bytes: Number(usage.bytes) };
}

export interface AccountStorage {
  plan: AccountPlan;
  usage: StorageUsage;
  limits: StorageLimits | null;
}

export async function accountStorage(
  session: Session,
): Promise<AccountStorage> {
  const plan = await accountPlan(session);
  return {
    plan,
    usage: await accountStorageUsage(session.accountId),
    limits: storageLimits(plan),
  };
}

/**
 * Refuses a new import or save that does not fit the account's plan, with
 * a reason code the page explains (and offers download and delete for).
 */
export async function assertStorageAvailable(
  session: Session,
  write: { newDocument?: boolean; addingBytes?: number },
): Promise<void> {
  const limits = storageLimits(await accountPlan(session));
  if (!limits) return;
  const problem = storageQuotaProblem(
    await accountStorageUsage(session.accountId),
    limits,
    write,
  );
  if (problem) throw new HttpError(403, problem);
}
