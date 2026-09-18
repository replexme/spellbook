import { redirect } from "next/navigation";

import NativeDocument from "@/components/native-document";
import { currentSession } from "@/lib/auth";
import { aiConnectorConfig } from "@/lib/ai-connector-config";
import { configuredEditorMode } from "@/lib/editor-mode";

export const dynamic = "force-dynamic";

export default async function BrowserDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!(await currentSession())) redirect("/auth/login");
  const { id } = await params;
  if (configuredEditorMode() !== "browser")
    redirect(`/documents/${encodeURIComponent(id)}`);
  return <NativeDocument documentId={id} launchMode="browser" aiConnector={aiConnectorConfig()} />;
}
