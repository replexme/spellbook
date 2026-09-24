const messages: Record<string, string> = {
  ai_rate_limited:
    "AI 요청이 많아 잠시 쉬어 갑니다. 조금 뒤에 다시 요청해 주세요. 직접 편집과 저장은 계속할 수 있습니다.",
  storage_capacity_exhausted:
    "저장 공간이 부족해 작업을 안전하게 중단했습니다. 기존 파일은 그대로 보존됩니다. 공간을 확보한 뒤 다시 시도해 주세요.",
};

export function userFacingError(
  error: string | null | undefined,
  fallback: string,
): string {
  if (!error || error === "unexpected_error") return fallback;
  return messages[error] ?? error;
}
