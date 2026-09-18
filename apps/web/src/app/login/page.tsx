import { redirect } from "next/navigation";

import { SignInScreen } from "@/components/sign-in-screen";
import { currentSession, safeRedirect } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; redirect?: string }>;
}) {
  const params = await searchParams;
  const destination = safeRedirect(params.redirect);
  if (await currentSession()) redirect(destination);
  return (
    <SignInScreen
      mode="local"
      destination={destination}
      error={params.error ? "이메일 또는 비밀번호가 올바르지 않습니다." : null}
    />
  );
}
