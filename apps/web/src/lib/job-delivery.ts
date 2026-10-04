const DEFAULT_JOB_REDELIVERY_SECONDS = 15;
const MIN_JOB_REDELIVERY_SECONDS = 5;
const MAX_JOB_REDELIVERY_SECONDS = 900;

// Native AI tools can mutate the live canvas before the final callback. A
// different process may take over a delivery only before the native worker
// claims it. Once any connector starts a native turn, an expired lease must
// fail visibly instead of replaying a possibly applied canvas edit.
export const NATIVE_AGENT_LEASE_SECONDS = 60;

export function jobRedeliverySeconds(
  value = process.env.SPELLBOOK_JOB_REDELIVERY_SECONDS,
): number {
  if (value === undefined || value.trim() === "")
    return DEFAULT_JOB_REDELIVERY_SECONDS;
  const seconds = Number(value);
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < MIN_JOB_REDELIVERY_SECONDS ||
    seconds > MAX_JOB_REDELIVERY_SECONDS
  )
    throw new Error(
      `SPELLBOOK_JOB_REDELIVERY_SECONDS must be an integer from ${MIN_JOB_REDELIVERY_SECONDS} to ${MAX_JOB_REDELIVERY_SECONDS}.`,
    );
  return seconds;
}

/**
 * When an unfinished document job (upload check, save check, edit render)
 * is sent again or given up. A job that never reached its queue is retried
 * after `retrySeconds`. A delivered job is left alone for `attemptSeconds`,
 * the worker's whole request budget, so a slow render is never run twice at
 * once. After `maxDeliveries` deliveries, or `maxAgeSeconds` after the job
 * was created, the job fails visibly with a reason the person can act on.
 */
export interface DocumentJobRecoveryPolicy {
  retrySeconds: number;
  attemptSeconds: number;
  maxDeliveries: number;
  maxAgeSeconds: number;
}

export interface DocumentJobDeliveryState {
  createdAt: Date;
  updatedAt: Date;
  dispatchedAt: Date | null;
  deliveryCount: number;
}

export type DocumentJobRecovery = "wait" | "redeliver" | "fail";

/** Reason code stored when a job is given up; upload-reasons.ts explains it. */
export const STALE_JOB_FAILURE_CODE = "processing_timeout";

// The document worker's request budget is 900 s (Cloud Run timeout) plus
// delivery; one attempt is never presumed lost before that has passed.
const DOCUMENT_JOB_ATTEMPT_SECONDS = 960;
const DOCUMENT_JOB_MAX_DELIVERIES = 3;
const DOCUMENT_JOB_MAX_AGE_SECONDS = 20 * 60;

export function documentJobRecoveryPolicy(
  env: Record<string, string | undefined> = process.env,
): DocumentJobRecoveryPolicy {
  return {
    retrySeconds: jobRedeliverySeconds(env.SPELLBOOK_JOB_REDELIVERY_SECONDS),
    attemptSeconds: DOCUMENT_JOB_ATTEMPT_SECONDS,
    maxDeliveries: DOCUMENT_JOB_MAX_DELIVERIES,
    maxAgeSeconds: DOCUMENT_JOB_MAX_AGE_SECONDS,
  };
}

export function documentJobRecovery(
  job: DocumentJobDeliveryState,
  now: Date,
  policy: DocumentJobRecoveryPolicy,
): DocumentJobRecovery {
  const secondsSince = (moment: Date) =>
    (now.getTime() - moment.getTime()) / 1000;
  if (secondsSince(job.createdAt) >= policy.maxAgeSeconds) return "fail";
  if (!job.dispatchedAt)
    return secondsSince(job.updatedAt) >= policy.retrySeconds
      ? "redeliver"
      : "wait";
  if (secondsSince(job.dispatchedAt) < policy.attemptSeconds) return "wait";
  return job.deliveryCount >= policy.maxDeliveries ? "fail" : "redeliver";
}
