import { redirect } from "next/navigation";

import { SettingsScreen } from "@/components/settings/settings-screen";
import { aiConnectorConfig } from "@/lib/ai-connector-config";
import { currentSession } from "@/lib/auth";
import { accountStorage } from "@/lib/storage-usage";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await currentSession();
  if (!session) redirect("/auth/login?redirect=/settings");
  // Usage is informative; the page still opens if it cannot be measured.
  const storage = await accountStorage(session).catch(() => null);
  return (
    <SettingsScreen
      email={session.email}
      aiConnector={aiConnectorConfig()}
      storage={storage}
    />
  );
}
