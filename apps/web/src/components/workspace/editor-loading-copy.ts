/** Seconds after which the first open is slower than it should be. */
export const EDITOR_SLOW_SECONDS = 90;
/** Seconds after which the editor is treated as stuck. */
export const EDITOR_STUCK_SECONDS = 180;

/** One line of progress while the editor downloads and opens the file. */
export function editorLoadingMessage(seconds: number): string {
  if (seconds >= EDITOR_STUCK_SECONDS)
    return "편집기가 열리지 않고 있어요. 다시 시도하거나, 다른 탭을 닫고 새로 고쳐 보세요.";
  if (seconds >= EDITOR_SLOW_SECONDS)
    return `평소보다 오래 걸려요 · ${seconds}초. 처음 한 번은 편집기를 내려받느라 인터넷이 느리면 몇 분 걸릴 수 있어요.`;
  if (seconds >= 15)
    return `편집기 준비 중 · ${seconds}초 · 처음 열 때는 1분쯤 걸려요`;
  return "편집기 준비 중 · 처음 열 때는 1분쯤 걸려요";
}
