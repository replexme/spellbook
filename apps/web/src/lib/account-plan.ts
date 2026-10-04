import type { Session } from "./models";

/*
 * What the signed-in account's plan allows. A self-hosted server has a single
 * plan: no ads and no storage limit beyond its own disks. The managed service
 * replaces this file (see its web Dockerfile) to read the plan from its own
 * accounts and billing; nothing else in the product knows about plans.
 */
export interface AccountPlan {
  /** "self_hosted", or the managed service's plan id. */
  id: string;
  /** The work screen shows the managed service's ad strip. */
  showsAds: boolean;
  /** Total bytes this account may store, or null for no limit. */
  storageLimitBytes: number | null;
  /** Documents this account may keep, or null for no limit. */
  documentLimit: number | null;
}

export const SELF_HOSTED_PLAN: AccountPlan = Object.freeze({
  id: "self_hosted",
  showsAds: false,
  storageLimitBytes: null,
  documentLimit: null,
});

export async function accountPlan(session: Session): Promise<AccountPlan> {
  void session;
  return SELF_HOSTED_PLAN;
}
