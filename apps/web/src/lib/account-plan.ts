import type { Session } from "./models";
import type { AccountPlan } from "./storage-quota";

export type { AccountPlan };

/**
 * The account's plan: "pro" lifts the storage limits in storage-quota.ts.
 *
 * A self-hosted server has no billing; SPELLBOOK_ACCOUNT_PLAN=pro lifts the
 * limits for every account. A managed deployment replaces this module with
 * one that reads the account's paid entitlement.
 */
export async function accountPlan(_session: Session): Promise<AccountPlan> {
  return process.env.SPELLBOOK_ACCOUNT_PLAN?.trim() === "pro" ? "pro" : "free";
}
