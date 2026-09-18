import { redirect } from "next/navigation";

import { currentSession } from "@/lib/auth";
import NativeDocument from "@/components/native-document";
import { aiConnectorConfig } from "@/lib/ai-connector-config";
import { configuredEditorMode } from "@/lib/editor-mode";

export const dynamic = "force-dynamic";

export default async function DocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!(await currentSession())) redirect("/auth/login");
  const { id } = await params;
  if (configuredEditorMode() === "browser")
    redirect(`/browser-documents/${encodeURIComponent(id)}`);
  return <NativeDocument documentId={id} launchMode="wopi" aiConnector={aiConnectorConfig()} />;
}
