/*
 * Korean explanations for AI failures, specific to the AI the person chose.
 * Workers report a stable reason (`ai_failure:<reason>`); browser-run
 * requests and older records report provider text, which is classified
 * here. Neither raw provider text nor internal codes are shown.
 */

export type AiFailureReason =
  | "cancelled"
  | "busy"
  | "not_connected"
  | "usage_limit"
  | "quota_exhausted"
  | "auth_expired"
  | "model_unavailable"
  | "timeout"
  | "document_changed"
  | "failed";

const SUBSCRIPTIONS = new Set(["codex", "claude_code"]);

const LABELS: Record<string, string> = {
  codex: "ChatGPT 구독",
  claude_code: "Claude 구독",
  openai_api: "OpenAI API",
  anthropic_api: "Anthropic API",
  gemini_api: "Google Gemini API",
  openrouter_api: "OpenRouter API",
};

/** The AI's name as the settings page shows it. Unset means the server default. */
export function aiProviderLabel(provider?: string | null): string {
  return LABELS[provider ?? "codex"] ?? "AI";
}

const RESET_OR_SWITCH =
  "한도가 다시 채워지면 이어서 쓸 수 있어요. 지금 이어 하려면 설정에서 다른 AI를 골라 주세요.";

export function aiFailureMessage(
  reason: AiFailureReason,
  provider?: string | null,
): string {
  const id = provider ?? "codex";
  const label = aiProviderLabel(id);
  const subscription = SUBSCRIPTIONS.has(id);
  switch (reason) {
    case "cancelled":
      return "요청을 중단했어요. 중단 전까지 바뀐 것이 있으면 아래에 보여요.";
    case "busy":
      return `같은 ${label} 계정으로 다른 요청이 아직 진행 중이에요. 그 요청이 끝난 뒤 다시 요청해 주세요.`;
    case "not_connected":
      return subscription
        ? `${label}이 연결돼 있지 않아요. 설정에서 연결하거나 다른 AI를 골라 주세요.`
        : `이 브라우저에 ${label} 키가 없어요. 설정에서 키를 등록해 주세요.`;
    case "usage_limit":
      return subscription
        ? `${label}의 사용 한도에 도달했어요. ${RESET_OR_SWITCH}`
        : `${label} 요청 한도에 걸렸어요. 잠시 뒤 다시 요청하거나 설정에서 다른 AI를 골라 주세요.`;
    case "quota_exhausted":
      return subscription
        ? `${label}의 사용 한도에 도달했어요. ${RESET_OR_SWITCH}`
        : `${label} 계정의 잔액(크레딧)이 부족해요. 해당 서비스의 결제 상태를 확인하거나 설정에서 다른 AI를 골라 주세요.`;
    case "auth_expired":
      return subscription
        ? `${label} 로그인이 만료됐어요. 설정에서 ${label}을 다시 연결해 주세요.`
        : `${label} 키가 올바르지 않거나 만료됐어요. 설정에서 키를 확인해 주세요.`;
    case "model_unavailable":
      return `선택한 ${label} 모델을 지금 쓸 수 없어요. 다른 모델을 골라 다시 요청해 주세요.`;
    case "timeout":
      return "AI 응답이 너무 오래 걸려 멈췄어요. 요청을 조금 나눠서 다시 보내 주세요.";
    case "document_changed":
      return "작업 중에 문서가 바뀌어서 멈췄어요. 다시 요청하면 바뀐 문서를 보고 이어서 해요.";
    case "failed":
      return "AI가 요청을 끝내지 못했어요. 잠시 뒤 다시 요청해 주세요.";
  }
}

const REASONS = new Set<AiFailureReason>([
  "cancelled",
  "busy",
  "not_connected",
  "usage_limit",
  "quota_exhausted",
  "auth_expired",
  "model_unavailable",
  "timeout",
  "document_changed",
  "failed",
]);

/** The reason a worker reported, or null for any other text. */
export function reportedAiFailure(
  error: string | null | undefined,
): AiFailureReason | null {
  const match = /^ai_failure:([a-z_]+)/u.exec(error ?? "");
  return match && REASONS.has(match[1] as AiFailureReason)
    ? (match[1] as AiFailureReason)
    : null;
}

/** Provider or connector text (often English) classified into a reason. */
const PROVIDER_TEXT: Array<[RegExp, AiFailureReason]> = [
  [/ai_subscription_busy/, "busy"],
  [
    /subscription is not connected|ai_account_not_connected|not logged in|please run \/login|API 키가 필요|키가 없어요/i,
    "not_connected",
  ],
  [
    /insufficient_quota|exceeded your current quota|credit balance|billing|payment required|\b402\b|잔액|크레딧/i,
    "quota_exhausted",
  ],
  [
    /usage limit|rate[ _-]?limit|out of codex messages|limit reached|too many requests|\b429\b|사용 한도/i,
    "usage_limit",
  ],
  [
    /invalid[ _-]?api[ _-]?key|api_key_required|incorrect api key|invalid x-api-key|\b401\b|unauthori[sz]ed|authentication|oauth token|token (has )?(expired|revoked)|login (expired|required)/i,
    "auth_expired",
  ],
  [
    /selected_model_unavailable|selected (claude )?model|model[^.]{0,40}(not found|unavailable|unsupported|not supported|does not exist)|model_not_found/i,
    "model_unavailable",
  ],
];

export function classifyAiFailure(
  error: string | null | undefined,
): AiFailureReason | null {
  const reported = reportedAiFailure(error);
  if (reported) return reported;
  const text = error ?? "";
  for (const [test, reason] of PROVIDER_TEXT) if (test.test(text)) return reason;
  return null;
}

/** Whether a message is already a sentence meant for the person. */
export function isKoreanSentence(text: string): boolean {
  return /[가-힣]/u.test(text) && !/^[a-z0-9_:.-]+$/iu.test(text);
}

const REQUEST_ERRORS: Record<string, string> = {
  ai_rate_limited:
    "AI 요청이 많아 잠시 쉬어 갑니다. 조금 뒤에 다시 요청해 주세요. 직접 편집과 저장은 계속할 수 있습니다.",
  native_ai_unavailable:
    "AI 작업기에 연결하지 못했어요. 잠시 뒤 다시 요청해 주세요.",
  native_session_not_active:
    "편집 화면 연결이 끊겼어요. 문서를 다시 연 뒤 요청해 주세요.",
  native_save_validation_in_progress:
    "문서를 저장하는 중이에요. 저장이 끝난 뒤 다시 요청해 주세요.",
  native_document_context_not_ready:
    "문서를 아직 준비하고 있어요. 잠시 뒤 다시 요청해 주세요.",
  invalid_native_request: "요청 내용을 2,000자 이내로 적어 주세요.",
  invalid_native_permission: "AI가 고칠 범위를 다시 골라 주세요.",
  invalid_native_execution:
    "AI 연결 방식이 바뀌었어요. 화면을 새로 고친 뒤 다시 요청해 주세요.",
  local_connector_required:
    "이 서버는 이 컴퓨터의 Spellbook 연결 앱으로 AI를 연결해요.",
  web_page_rate_limited:
    "웹페이지를 너무 많이 읽었어요. 잠시 뒤 다시 요청해 주세요.",
  web_page_request_limit: "한 요청에서 읽을 수 있는 웹페이지 수를 넘었어요.",
};

/**
 * The sentence for an error from sending an AI request (a route's error
 * code or a provider's text). Unknown internal codes fall back.
 */
export function aiRequestError(
  error: string | null | undefined,
  fallback: string,
  provider?: string | null,
): string {
  if (!error) return fallback;
  if (REQUEST_ERRORS[error]) return REQUEST_ERRORS[error];
  // A sentence this app already wrote for the person is kept as it is.
  if (isKoreanSentence(error) && !reportedAiFailure(error)) return error;
  const reason = classifyAiFailure(error);
  return reason ? aiFailureMessage(reason, provider) : fallback;
}
