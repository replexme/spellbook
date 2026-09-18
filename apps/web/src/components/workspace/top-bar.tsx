"use client";

import { Button, Icon, IconButton } from "@/design-system";

export type SaveView = {
  kind: "saved" | "dirty" | "busy" | "error" | "opening";
  label: string;
};

/** Maps the editor bridge's save state to the one visible save indicator. */
export function saveView(state: string, engineReady: boolean, savedAt: string | null): SaveView {
  if (!engineReady) return { kind: "opening", label: "여는 중…" };
  if (state === "저장됨")
    return { kind: "saved", label: savedAt ? `저장됨 · ${savedAt}` : "저장됨" };
  if (state === "변경 사항 있음") return { kind: "dirty", label: "저장 안 됨 · 지금 저장" };
  if (state === "복구된 변경 사항 있음")
    return { kind: "dirty", label: "복구한 변경 있음 · 지금 저장" };
  if (state === "저장 실패") return { kind: "error", label: "저장하지 못함 · 다시 시도" };
  return { kind: "busy", label: state };
}

export function WorkspaceTopBar({
  fileName,
  save,
  onSave,
  editorReady,
  onUndo,
  onRedo,
  versionsOpen,
  onVersions,
  onDownload,
  panelOpen,
  onTogglePanel,
  disabled = false,
}: {
  fileName: string;
  save: SaveView;
  onSave: () => void;
  editorReady: boolean;
  onUndo: () => void;
  onRedo: () => void;
  versionsOpen: boolean;
  onVersions: () => void;
  onDownload: () => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
  /** Before the editor exists (opening, failure): show the bar, allow nothing. */
  disabled?: boolean;
}) {
  const baseName = fileName.replace(/\.pptx$/i, "");
  const extension = fileName.slice(baseName.length);
  const actionable = save.kind === "dirty" || save.kind === "error";
  return (
    <header className="ws-topbar">
      <a className="ws-back" href="/" aria-label="파일 목록으로">
        <Icon name="back" size={17} />
        <span>파일</span>
      </a>
      <span className="ws-divider" aria-hidden="true" />
      <div className="ws-file">
        <span className="ws-file-name" title={fileName}>
          <span>{baseName}</span>
          <span>{extension}</span>
        </span>
        {actionable ? (
          <button
            type="button"
            className={`ws-save is-${save.kind}`}
            onClick={onSave}
            aria-live="polite"
          >
            <i aria-hidden="true" />
            {save.label}
          </button>
        ) : (
          <span className={`ws-save is-${save.kind}`} role="status">
            {save.kind === "busy" || save.kind === "opening" ? (
              <span className="ds-spinner" aria-hidden="true" />
            ) : (
              <i aria-hidden="true" />
            )}
            {save.label}
          </span>
        )}
      </div>
      <div className="ws-actions">
        <IconButton icon="undo" label="실행 취소" className="ws-hide-phone" disabled={!editorReady} onClick={onUndo} />
        <IconButton icon="redo" label="다시 실행" className="ws-hide-phone" disabled={!editorReady} onClick={onRedo} />
        <span className="ws-divider ws-hide-narrow" aria-hidden="true" />
        <Button
          variant="quiet"
          icon="clock"
          className="ws-hide-narrow"
          aria-pressed={versionsOpen}
          disabled={disabled}
          onClick={onVersions}
        >
          버전
        </Button>
        <Button
          icon="download"
          aria-label="PPTX 내려받기"
          disabled={!editorReady}
          onClick={onDownload}
        >
          <span className="ws-hide-narrow">내려받기</span>
        </Button>
        <Button
          variant={panelOpen ? "ai-soft" : "ai"}
          icon="sparkles"
          aria-expanded={panelOpen}
          aria-label="AI 패널"
          disabled={disabled}
          onClick={onTogglePanel}
        >
          AI
        </Button>
      </div>
    </header>
  );
}
