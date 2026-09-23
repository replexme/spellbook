import { HomeScreen } from "@/components/home/home-screen";
import { SignInScreen } from "@/components/sign-in-screen";
import { aiConnectorConfig } from "@/lib/ai-connector-config";
import { currentSession } from "@/lib/auth";
import { currentPresentationFormat } from "@/lib/document-formats";
import { signInErrorMessage } from "@/lib/sign-in-errors";

export const dynamic = "force-dynamic";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await currentSession();
  if (!session) {
    const { error } = await searchParams;
    return (
      <SignInScreen
        mode={
          process.env.SPELLBOOK_AUTH_MODE === "external" ? "external" : "local"
        }
        error={signInErrorMessage(error)}
      />
    );
  }
  return (
    <HomeScreen
      email={session.email}
      aiConnector={aiConnectorConfig()}
      maxBytes={currentPresentationFormat.maxBytes}
    />
  );
}
