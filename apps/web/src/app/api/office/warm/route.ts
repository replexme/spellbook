import { configuredEditorMode } from "@/lib/editor-mode";
import { requireSession, routeError } from "@/lib/http";
import { warmOfficeEditor } from "@/lib/native-session";

export async function POST(request: Request) {
  try {
    await requireSession(request);
    // The browser editor runs in the visitor's browser; only the server
    // editor has an instance to wake before a document opens.
    if (configuredEditorMode() === "wopi") await warmOfficeEditor();
    return Response.json({ ready: true });
  } catch (error) {
    return routeError(error);
  }
}
