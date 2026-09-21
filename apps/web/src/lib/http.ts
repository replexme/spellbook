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

export function routeError(error: unknown): Response {
  if (error instanceof StorageCapacityError)
    return Response.json({ error: error.message }, { status: 507 });
  if (error instanceof HttpError)
    return Response.json({ error: error.message }, { status: error.status });
  const message = error instanceof Error ? error.message : "unexpected_error";
  console.error(error);
  return Response.json({ error: message }, { status: 400 });
}
