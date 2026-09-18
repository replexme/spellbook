"use client";

import {
  Button,
  CheckList,
  Dialog,
  FileMark,
  Spinner,
  type CheckItem,
} from "@/design-system";
import type { DocumentSummary } from "@/lib/history-types";
import { fontCheck, renderCheck } from "../document-checks";
import { fileSize, when } from "../copy";

/** Checks shown before a file leaves Spellbook. Only performed checks get a mark. */
export function downloadChecks(summary: DocumentSummary | null, saved: boolean): CheckItem[] {
  const items: CheckItem[] = [];
  if (saved && summary?.version)
    items.push({
      tone: "ok",
      label: `마지막 변경까지 저장했어요 · ${when(summary.version.createdAt)}`,
      evidence: "editor save state and current version",
    });
  else
    items.push({
      tone: "na",
      label: "내려받기를 누르면 저장하지 않은 변경을 먼저 저장해요",
      evidence: "save before download",
    });
  const rendered = renderCheck(summary);
  if (rendered) items.push(rendered);
  if (summary?.version?.origin === "ai" && summary.version.changeCheck === true)
    items.push({
      tone: "ok",
      label: "AI가 허용한 범위 밖을 바꾸지 않았는지 저장 파일에서 다시 검사했어요",
      evidence: "validation.json PackageChangeBudgetReport.valid",
    });
  const fonts = fontCheck(summary);
  if (fonts) items.push(fonts);
  items.push({
    tone: "na",
    label: "PowerPoint에서 직접 열어 보는 확인은 아직 하지 않아요",
    evidence: "no automated PowerPoint reopen gate",
  });
  return items;
}

export function DownloadDialog({
  open,
  onClose,
  fileName,
  summary,
  loading,
  saved,
  busy,
  waiting = false,
  onDownload,
}: {
  open: boolean;
  onClose: () => void;
  fileName: string;
  summary: DocumentSummary | null;
  loading: boolean;
  saved: boolean;
  busy: boolean;
  /** Another save is still running; download after it finishes. */
  waiting?: boolean;
  onDownload: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="내려받기"
      dismissible={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            취소
          </Button>
          <Button variant="primary" icon="download" loading={busy} disabled={waiting} onClick={onDownload}>
            {waiting
              ? "저장이 끝나기를 기다리는 중"
              : saved
                ? `PPTX 내려받기${summary?.version?.bytes ? ` · ${fileSize(summary.version.bytes)}` : ""}`
                : "저장하고 내려받기"}
          </Button>
        </>
      }
    >
      <div className="file-line">
        <FileMark />
        <div>
          <strong>{fileName}</strong>
          <small>PowerPoint 프레젠테이션 · 계속 고칠 수 있는 원래 형식</small>
        </div>
        <span />
      </div>
      <p className="ds-label">확인한 것</p>
      {loading ? (
        <p className="connect-status" role="status">
          <Spinner /> 마지막 저장본의 검사 결과를 불러오고 있어요.
        </p>
      ) : (
        <CheckList items={downloadChecks(summary, saved)} label="내려받기 전 확인" />
      )}
    </Dialog>
  );
}
