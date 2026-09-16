import type { TransactionSql } from "postgres";

import { currentPresentationFormat } from "./document-formats";
import { db } from "./db";
import { loadNativeSaveChangePolicy } from "./native-change-budget";
import { internalAppBaseUrl } from "./runtime-urls";
import { storageNamespace } from "./storage";
import { enqueueWorkerJob } from "./workers";

interface NativeSaveStage {
  sessionId: string;
  documentId: string;
  parentVersionId: string;
  versionId: string;
  jobId: string;
  object: string;
  outputPrefix: string;
  digest: string;
  preservationObject: string;
  saveRevision: number;
}

/**
 * WOPI and browser editing have different authorization and concurrency
 * checks. Once either owns the locked session row, the version lineage,
 * validation job and save policy must be identical.
 */
export async function stageNativeSave(
  sql: TransactionSql,
  stage: NativeSaveStage,
): Promise<Record<string, unknown>> {
  const policy = await loadNativeSaveChangePolicy(
    sql,
    stage.sessionId,
    stage.saveRevision,
  );
  const payload: Record<string, unknown> = {
    jobId: stage.jobId,
    callbackUrl: `${internalAppBaseUrl()}/api/internal/jobs/callback`,
    storageNamespace: storageNamespace(),
    formatId: currentPresentationFormat.id,
    inputObject: stage.object,
    baselineInputObject: stage.preservationObject,
    outputPrefix: stage.outputPrefix,
    nativeSessionId: stage.sessionId,
    changeOrigin: policy.origin,
    changeTaskIds: policy.taskIds,
    changeBudget: policy.budget,
  };
  await sql`
    insert into spellbook_versions
      (id,document_id,parent_version_id,kind,status,document_object,document_sha256)
    values (${stage.versionId},${stage.documentId},${stage.parentVersionId},'approved','processing',${stage.object},${stage.digest})
  `;
  await sql`
    insert into spellbook_jobs
      (id,job_type,document_id,version_id,status,payload)
    values (${stage.jobId},'scan_render',${stage.documentId},${stage.versionId},'queued',${sql.json(payload as any)})
  `;
  await sql`
    update spellbook_native_sessions set
      working_version_id=${stage.versionId},working_sha256=${stage.digest},
      status='validating',save_revision=save_revision+1,last_error=null,
      last_seen_at=now(),updated_at=now()
    where id=${stage.sessionId}
  `;
  return payload;
}

export async function dispatchNativeSave(
  jobId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await enqueueWorkerJob(
      jobId,
      "document",
      "/internal/jobs/scan-render",
      payload,
    );
    await db()`update spellbook_jobs set dispatched_at=now() where id=${jobId}`;
  } catch (error) {
    await db()`update spellbook_jobs set error=${error instanceof Error ? error.message : "dispatch_failed"} where id=${jobId}`;
  }
}
