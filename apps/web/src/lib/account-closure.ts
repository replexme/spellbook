import { HttpError } from "./http";
import type { Session } from "./models";

/*
 * Closing the signed-in account from the settings screen. A self-hosted
 * install manages its local accounts outside the app, so it offers nothing
 * here. The managed service replaces this file with a request to its
 * central account service (see the managed web Dockerfile).
 */

/** What the confirmation explains before an account is closed. */
export interface AccountClosureInfo {
  /** What is deleted, one short line each. */
  deletes: string[];
  /** Anything else the person must know, such as other services affected. */
  notes: string[];
}

export type AccountClosureResult =
  | { status: "accepted" }
  /** The account may not be closed here (for example an operator account). */
  | { status: "blocked" };

export function accountClosureInfo(): AccountClosureInfo | null {
  return null;
}

export async function requestAccountClosure(
  _session: Session,
): Promise<AccountClosureResult> {
  throw new HttpError(404, "account_closure_unavailable");
}
