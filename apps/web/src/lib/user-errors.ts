/*
 * What a person reads when something fails. Server routes and the editor
 * report short reason codes (`document_not_found`) or, from a bug, raw
 * exception text. Neither is shown as it is: a known code becomes a plain
 * Korean sentence, Korean text written for people passes through, and
 * anything else becomes the caller's Korean fallback.
 */

const TRY_AGAIN = "잠시 뒤 다시 시도해 주세요.";
const RELOAD = "페이지를 새로 고친 뒤 다시 시도해 주세요.";
const SAFE = "파일은 그대로 저장돼 있어요.";

const messages: Record<string, string> = {
  // Session and access
  login_required: "로그인이 끝났어요. 다시 로그인해 주세요.",
  access_denied: "이 계정으로는 이 기능을 쓸 수 없어요.",
  access_unavailable: `지금은 계정 권한을 확인할 수 없어요. ${TRY_AGAIN}`,
  account_deletion_in_progress:
    "계정 삭제가 진행 중이라 새 작업을 시작할 수 없어요.",
  auth_unavailable: `지금은 로그인 상태를 확인할 수 없어요. ${TRY_AGAIN}`,
  account_closure_not_confirmed: "확인 단어를 정확히 입력해 주세요.",
  account_closure_unavailable: `지금은 계정 삭제를 요청할 수 없어요. ${TRY_AGAIN}`,

  // Files
  document_not_found: "파일을 찾을 수 없어요. 삭제됐을 수 있어요.",
  version_not_found: "그 버전을 찾을 수 없어요. 버전 기록을 다시 열어 주세요.",
  document_processing: "파일을 아직 확인하고 있어요. 조금 뒤 다시 열어 주세요.",
  document_not_ready: "파일을 아직 확인하고 있어요. 조금 뒤 다시 열어 주세요.",
  document_processing_failed:
    "이 파일을 편집할 수 있게 준비하지 못했어요. 원본은 그대로 있어요.",
  document_context_not_ready: `편집기가 파일을 아직 읽고 있어요. ${TRY_AGAIN}`,
  native_document_context_not_ready: `편집기가 파일을 아직 읽고 있어요. ${TRY_AGAIN}`,
  document_graph_not_ready: `편집기가 파일을 아직 읽고 있어요. ${TRY_AGAIN}`,
  document_too_large:
    "파일이 너무 커서 저장하지 못했어요. 큰 그림이나 동영상을 줄여 주세요.",
  file_too_large:
    "파일이 너무 커요. 큰 그림이나 동영상을 줄인 뒤 가져와 주세요.",
  empty_file: "빈 파일이에요. PowerPoint에서 다시 저장해 주세요.",
  unsupported_format: "PowerPoint 파일(.pptx)만 가져올 수 있어요.",
  invalid_document_package:
    "저장하려던 파일이 올바른 PPTX가 아니에요. 편집 내용을 확인하고 다시 저장해 주세요.",
  invalid_file_name: "파일 이름에 쓸 수 없는 글자가 있어요.",
  file_name_too_long: "파일 이름이 너무 길어요.",
  invalid_download_source: "내려받을 파일을 찾지 못했어요.",
  candidate_review_required:
    "AI가 고친 결과를 먼저 확인해 주세요. 적용하거나 되돌린 뒤 계속할 수 있어요.",
  storage_capacity_exhausted:
    "저장 공간이 부족해 작업을 안전하게 중단했어요. 기존 파일은 그대로 있어요. 공간을 확보한 뒤 다시 시도해 주세요.",

  // Editor and saving
  office_editor_starting:
    "편집기를 준비하고 있어요. 처음 열 때는 1분쯤 걸려요.",
  browser_office_not_configured: `브라우저 편집기가 아직 설정되지 않았어요. ${SAFE}`,
  format_editor_not_available: "이 형식은 아직 편집기로 열 수 없어요.",
  browser_session_not_active: `편집 연결이 끊겼어요. ${RELOAD}`,
  native_session_not_active: `편집 연결이 끊겼어요. ${RELOAD}`,
  browser_session_changed:
    "다른 탭이나 기기에서 이 파일을 열어 연결이 바뀌었어요. 이 탭을 새로 고쳐 주세요.",
  browser_revision_changed:
    "다른 곳에서 이 파일이 먼저 저장됐어요. 이 탭을 새로 고쳐 최신 내용을 불러와 주세요.",
  browser_revision_required: `저장 정보가 맞지 않아요. ${RELOAD}`,
  browser_save_revision_missing: `저장을 확인하지 못했어요. ${RELOAD}`,
  browser_document_save_failed:
    "이 파일의 변경을 안전하게 저장하지 못했어요. 편집 내용을 확인하고 다시 시도해 주세요.",
  browser_document_download_failed: `파일을 내려받지 못했어요. ${TRY_AGAIN}`,
  browser_document_validation_failed:
    "저장한 파일을 확인하는 중에 문제가 생겼어요. 편집 내용을 확인하고 다시 저장해 주세요.",
  office_editor_save_required: "먼저 지금 편집 내용을 저장해 주세요.",
  document_save_in_progress:
    "저장하는 중이에요. 저장이 끝나면 다시 시도해 주세요.",
  native_save_validation_in_progress:
    "저장한 내용을 확인하는 중이에요. 확인이 끝나면 다시 시도해 주세요.",
  document_changed:
    "다른 곳에서 파일이 바뀌었어요. 새로 고친 뒤 다시 시도해 주세요.",
  invalid_browser_origin: `편집기 연결을 확인하지 못했어요. ${RELOAD}`,
  editor_timeout: `편집기가 응답하지 않아요. ${RELOAD}`,
  editor_not_connected: `편집기에 아직 연결되지 않았어요. ${TRY_AGAIN}`,
  editor_save_not_received: `편집기에서 저장 결과를 받지 못했어요. ${TRY_AGAIN}`,
  document_load_failed: `파일을 편집기에 불러오지 못했어요. ${RELOAD}`,
  browser_document_identity_mismatch: `편집기에 불러온 파일이 최신 저장본과 달라요. ${RELOAD}`,
  undo_nothing_changed: "되돌릴 변경이 없어요.",
  undo_not_latest_request: "가장 최근 요청부터 되돌릴 수 있어요.",
  no_previous_version: "되돌아갈 이전 버전이 없어요.",
  versions_unavailable: `버전 기록을 불러오지 못했어요. ${TRY_AGAIN}`,

  // Assets
  asset_not_found: "그 파일을 찾을 수 없어요.",
  asset_too_large: "올린 그림이나 미디어 파일이 너무 커요.",
  media_too_large: "올린 미디어 파일이 너무 커요.",
  image_requires_png_or_jpeg_under_5mb_and_16mp:
    "그림은 5MB 이하의 PNG나 JPG만 넣을 수 있어요.",
  unsupported_or_invalid_media: "이 형식의 파일은 넣을 수 없어요.",
  asset_download_failed: `파일을 가져오지 못했어요. ${TRY_AGAIN}`,

  // AI
  ai_rate_limited:
    "AI 요청이 많아 잠시 쉬어 가요. 조금 뒤에 다시 요청해 주세요. 직접 편집과 저장은 계속할 수 있어요.",
  ai_subscription_busy:
    "연결한 AI 계정이 이전 요청을 아직 처리하고 있어요. 잠시 뒤 다시 요청해 주세요.",
  native_ai_unavailable: `AI 서버에 연결하지 못했어요. ${TRY_AGAIN} 직접 편집은 계속할 수 있어요.`,
  native_turn_already_running:
    "AI가 이전 요청을 처리하고 있어요. 끝난 뒤 다시 요청해 주세요.",
  no_active_native_turn: "진행 중인 AI 작업이 없어요.",
  no_active_turn: "진행 중인 AI 작업이 없어요.",
  invalid_native_request:
    "요청 내용이 비어 있거나 너무 길어요. 2,000자 안으로 적어 주세요.",
  native_request_too_large: "요청 내용이 너무 길어요.",
  selected_model_unavailable:
    "고른 AI 모델을 지금 쓸 수 없어요. 다른 모델을 골라 주세요.",
  model_not_selected: "사용할 AI 모델을 골라 주세요.",
  models_unavailable: `AI 모델 목록을 불러오지 못했어요. ${TRY_AGAIN}`,
  models_empty:
    "쓸 수 있는 AI 모델이 없어요. 설정에서 AI 연결을 확인해 주세요.",
  ai_edit_permission_required: "AI가 고칠 수 있는 범위를 먼저 골라 주세요.",
  outside_edit_permission: "허락한 범위 밖은 AI가 고칠 수 없어요.",
  ai_turn_timed_out:
    "AI가 제한 시간 안에 끝내지 못했어요. 요청을 나눠서 다시 부탁해 주세요.",
  claude_login_expired:
    "Claude 로그인 시간이 지났어요. 로그인을 다시 시작해 주세요.",
  claude_login_code_invalid:
    "Claude 로그인 코드가 맞지 않아요. 코드를 다시 복사해 붙여 넣어 주세요.",
  local_connector_unavailable:
    "이 컴퓨터의 연결 앱을 찾지 못했어요. 연결 앱이 켜져 있는지 확인해 주세요.",
  local_connector_not_paired: "연결 앱이 아직 이 브라우저와 연결되지 않았어요.",
  local_connector_popup_blocked:
    "팝업이 막혔어요. 이 사이트의 팝업을 허용한 뒤 다시 시도해 주세요.",
  local_pairing_timed_out: "연결 앱 연결 시간이 지났어요. 다시 시도해 주세요.",

  // Network
  network: "인터넷 연결이 끊겼어요. 연결을 확인한 뒤 다시 시도해 주세요.",
  request_failed: `요청을 처리하지 못했어요. ${TRY_AGAIN}`,
};

/** Sentences written for people contain Hangul; codes and stack text do not. */
const HANGUL = /[ㄱ-ㆎ가-힣]/;

export function isKnownErrorCode(error: string | null | undefined): boolean {
  return Boolean(error && Object.hasOwn(messages, error));
}

/** Korean text for an error code or message; never the raw code itself. */
export function userFacingError(
  error: string | null | undefined,
  fallback: string,
): string {
  if (!error) return fallback;
  const code = error.trim();
  if (Object.hasOwn(messages, code)) return messages[code]!;
  if (HANGUL.test(code) && code.length <= 400) return code;
  return fallback;
}

/** Whether a failure needs the person to contact support to be understood. */
export function errorNeedsReference(error: string | null | undefined): boolean {
  if (!error) return true;
  const code = error.trim();
  return !Object.hasOwn(messages, code) && !HANGUL.test(code);
}

/** The generic sentence for a failure nobody described. */
export const UNEXPECTED_ERROR = `예상하지 못한 문제가 생겼어요. ${TRY_AGAIN}`;
