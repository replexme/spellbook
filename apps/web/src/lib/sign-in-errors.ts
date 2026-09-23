// Error codes that sign-in routes put in `/?error=`. Anything else, including
// raw provider error text, is shown as a generic message instead of verbatim.
const SIGN_IN_ERROR_MESSAGES: Record<string, string> = {
  invalid_state: "로그인 시간이 만료되었습니다. 다시 시도해 주세요.",
  account_link_failed:
    "계정 연결을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  access_denied: "이 계정에는 이 서비스를 이용할 권한이 없습니다.",
  access_unavailable:
    "지금은 계정 권한을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.",
  verified_email_required: "이메일 인증을 마친 계정이 필요합니다.",
  account_deletion_in_progress:
    "계정 삭제가 진행 중이므로 새 작업을 시작할 수 없습니다.",
  login_failed: "로그인을 확인하지 못했습니다. 다시 시도해 주세요.",
};

export function signInErrorMessage(
  code: string | null | undefined,
): string | null {
  if (!code) return null;
  return (
    SIGN_IN_ERROR_MESSAGES[code] ?? "로그인하지 못했습니다. 다시 시도해 주세요."
  );
}
