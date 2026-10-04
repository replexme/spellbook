import { redirect } from "next/navigation";

import { accountPlan } from "@/lib/account-plan";
import { currentSession } from "@/lib/auth";
import { recordUsageEvent } from "@/lib/usage-events";
import NativeDocument from "@/components/native-document";
import { aiConnectorConfig } from "@/lib/ai-connector-config";
import { configuredEditorMode } from "@/lib/editor-mode";

export const dynamic = "force-dynamic";

export default async function DocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await currentSession();
  if (!session) redirect("/auth/login");
  await recordUsageEvent(session.accountId, { type: "visit" });
  const plan = await accountPlan(session);
  const { id } = await params;
  if (configuredEditorMode() === "browser")
    redirect(`/browser-documents/${encodeURIComponent(id)}`);
  return (
    <NativeDocument
      documentId={id}
      launchMode="wopi"
      aiConnector={aiConnectorConfig()}
      showAds={plan.showsAds}
    />
  );
}
