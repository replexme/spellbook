import { requireSession, routeError } from "@/lib/http";
import { callAiAccount } from "@/lib/workers";
import type { AvailableModel } from "@/lib/ai-models";

export const dynamic = "force-dynamic";

/** Subscription models the AI worker offers; the browser adds its API-key models. */
export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    let models: AvailableModel[] = [];
    try {
      const res = (await callAiAccount("/internal/models", session)) as {
        models?: AvailableModel[];
      };
      if (Array.isArray(res?.models)) models = res.models;
    } catch (caught) {
      console.error("Failed to fetch worker models:", caught);
    }
    return Response.json(
      { models },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return routeError(error);
  }
}
