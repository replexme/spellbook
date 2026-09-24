import { requireSession, routeError } from "@/lib/http";
import { callAiAccount } from "@/lib/workers";

export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    return Response.json(
      await callAiAccount("/internal/account/login/start", session),
    );
  } catch (error) {
    return routeError(error);
  }
}
