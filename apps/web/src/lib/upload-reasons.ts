/*
 * Why a file could not be imported, in two plain sentences: what is wrong,
 * and what to do. Keys are the reason codes the upload route returns.
 */

export type UploadFailure = { reason: string; fix: string };

const SAVE_AS_PPTX =
  "PowerPoint에서 ‘파일 › 다른 이름으로 저장 › PowerPoint 프레젠테이션(.pptx)’으로 저장한 뒤 다시 가져오세요.";

export function megabytes(bytes: number) {
  return Math.floor(bytes / 1024 / 1024);
}

export function uploadFailure(
  code: string | null | undefined,
  fileName: string,
  maxBytes: number,
): UploadFailure {
  switch (code) {
    case "unsupported_format":
      return /\.ppt$/i.test(fileName.trim())
        ? { reason: "옛 PowerPoint 형식(.ppt)이에요.", fix: SAVE_AS_PPTX }
        : {
            reason: "PowerPoint 파일(.pptx)만 가져올 수 있어요.",
            fix: "PowerPoint에서 .pptx로 저장한 파일을 골라 주세요.",
          };
    case "empty_file":
      return {
        reason: "빈 파일이에요.",
        fix: "PowerPoint에서 파일을 다시 저장한 뒤 가져오세요.",
      };
    case "file_too_large":
      return {
        reason: `파일이 ${megabytes(maxBytes)}MB보다 커요.`,
        fix: "큰 그림이나 동영상을 줄이거나, 슬라이드를 나눠 저장한 뒤 가져오세요.",
      };
    case "encrypted_or_legacy_file":
      return {
        reason: "암호가 걸린 파일이거나, 이름만 .pptx인 옛 형식 파일이에요.",
        fix: "PowerPoint에서 암호를 풀고 .pptx로 다시 저장한 뒤 가져오세요.",
      };
    case "invalid_package":
      return {
        reason: "PPTX 파일 구조가 아니에요. 파일이 손상됐을 수 있어요.",
        fix: "PowerPoint에서 열어 다시 저장한 뒤 가져오세요.",
      };
    case "broken_presentation":
      return {
        reason: "PowerPoint 파일 안의 슬라이드 구성이 손상됐어요.",
        fix: "PowerPoint에서 열어 다시 저장한 뒤 가져오세요. 올린 원본은 파일 목록에 남아 있어요.",
      };
    case "render_failed":
      return {
        reason: "서버에서 슬라이드를 그리지 못했어요.",
        fix: "PowerPoint에서 다시 저장한 뒤 가져와 보세요. 같은 문제가 계속되면 알려 주세요.",
      };
    case "processing_failed":
    case "document_processing_failed":
      return {
        reason:
          "파일을 여는 중에 문제가 생겼어요. 파일이 손상됐거나 아직 읽지 못하는 내용이 있을 수 있어요.",
        fix: "PowerPoint에서 열어 다시 저장한 뒤 가져와 보세요. 올린 원본은 파일 목록에 남아 있어요.",
      };
    case "storage_capacity_exhausted":
      return {
        reason: "서버 저장 공간이 부족해요.",
        fix: "공간을 확보한 뒤 다시 가져오세요. 기존 파일은 그대로 있어요.",
      };
    case "network":
      return {
        reason: "네트워크 연결이 끊겼어요.",
        fix: "연결을 확인한 뒤 다시 가져오세요.",
      };
    default:
      return {
        reason: "파일을 가져오지 못했어요.",
        fix: "잠시 뒤 다시 가져와 보세요.",
      };
  }
}

/** A few words for a file card: why the file could not be opened. */
export function failureShort(code: string | null | undefined): string {
  switch (code) {
    case "encrypted_or_legacy_file":
      return "암호가 걸렸거나 옛 형식인 파일이에요";
    case "invalid_package":
      return "파일이 손상됐어요";
    case "broken_presentation":
      return "슬라이드 구성이 손상됐어요";
    case "render_failed":
      return "슬라이드를 그리지 못했어요";
    default:
      return "파일을 읽지 못했어요";
  }
}

/** The checks the browser can do before sending anything. */
export function precheckUpload(
  file: { name: string; size: number },
  maxBytes: number,
): string | null {
  if (!/\.pptx$/i.test(file.name.trim())) return "unsupported_format";
  if (file.size <= 0) return "empty_file";
  if (file.size > maxBytes) return "file_too_large";
  return null;
}
