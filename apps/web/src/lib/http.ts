import { randomUUID } from "node:crypto";

import { sessionFromRequest } from "./auth";
import type { Session } from "./models";
import { StorageCapacityError } from "./storage";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function requireSession(request: Request): Promise<Session> {
  const session = await sessionFromRequest(request);
  if (!session) throw new HttpError(401, "login_required");
  return session;
}

// A reason code a client can map to its own words; anything else is
// exception text that may name tables, paths or document content.
const REASON_CODE = /^[a-z][a-z0-9_]{1,79}$/;

export function routeError(error: unknown): Response {
  if (error instanceof StorageCapacityError)
    return Response.json({ error: error.message }, { status: 507 });
  if (error instanceof HttpError)
    return Response.json({ error: error.message }, { status: error.status });
  const message = error instanceof Error ? error.message : "";
  if (REASON_CODE.test(message)) {
    console.error(error);
    return Response.json({ error: message }, { status: 400 });
  }
  // Unexplained failures get a reference the person can quote to support;
  // the server log keeps the detail under the same reference.
  const errorId = randomUUID().slice(0, 8).toUpperCase();
  console.error(`unexpected_error ${errorId}`, error);
  return Response.json(
    { error: "unexpected_error", errorId },
    { status: 500 },
  );
}
