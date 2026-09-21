import { requireSession, routeError } from "@/lib/http";
import { deleteProviderKey } from "@/lib/provider-keys";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    const body = (await request.json()) as { provider?: string };
    if (typeof body.provider !== "string" || !body.provider) {
      return Response.json({ error: "provider_required" }, { status: 400 });
    }
    await deleteProviderKey(session.accountId, body.provider);
    return Response.json({ status: "ok" });
  } catch (error) {
    return routeError(error);
  }
}
