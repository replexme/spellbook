import { redirect } from "next/navigation";

import NativeDocument from "@/components/native-document";
import { accountPlan } from "@/lib/account-plan";
import { currentSession } from "@/lib/auth";
import { aiConnectorConfig } from "@/lib/ai-connector-config";
import { browserEditorAvailable } from "@/lib/editor-mode";

export const dynamic = "force-dynamic";

export default async function BrowserDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await currentSession();
  if (!session) redirect("/auth/login");
  const plan = await accountPlan(session);
  const { id } = await params;
  if (!browserEditorAvailable())
    redirect(`/documents/${encodeURIComponent(id)}`);
  return (
    <NativeDocument
      documentId={id}
      launchMode="browser"
      aiConnector={aiConnectorConfig()}
      showAds={plan.showsAds}
    />
  );
}
