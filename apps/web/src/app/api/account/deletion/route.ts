import { cookies } from "next/headers";

import { requestAccountClosure } from "@/lib/account-closure";
import { ACCOUNT_CLOSURE_CONFIRMATION } from "@/lib/account-closure-confirmation";
import { SESSION_COOKIE } from "@/lib/auth";
import { requireBrowserOrigin } from "@/lib/browser-session";
import { HttpError, requireSession, routeError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    requireBrowserOrigin(request);
    const session = await requireSession(request);
    const body = (await request.json().catch(() => ({}))) as {
      confirm?: unknown;
    };
    if (body.confirm !== ACCOUNT_CLOSURE_CONFIRMATION)
      throw new HttpError(400, "account_closure_not_confirmed");
    const result = await requestAccountClosure(session);
    // Once accepted the account cannot keep working: end this session now.
    if (result.status === "accepted") (await cookies()).delete(SESSION_COOKIE);
    return Response.json(result, {
      status: result.status === "accepted" ? 202 : 409,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return routeError(error);
  }
}
