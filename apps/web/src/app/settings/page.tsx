import { redirect } from "next/navigation";

import { SettingsScreen } from "@/components/settings/settings-screen";
import { aiConnectorConfig } from "@/lib/ai-connector-config";
import { currentSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await currentSession();
  if (!session) redirect("/auth/login?redirect=/settings");
  return (
    <SettingsScreen email={session.email} aiConnector={aiConnectorConfig()} />
  );
}
