"use client";

import { Button, CheckList, Dialog, type CheckItem } from "@/design-system";
import { when } from "../copy";
import { impactSentence, type RestoreImpact } from "./turn-timeline";

export type RestoreTarget = {
  versionId: string;
  /** When the state being returned to was saved. */
  at: string;
  /** "“…” 요청 전 상태로 돌아가요." or the version's name. */
  lead: string;
  impact: RestoreImpact;
  /** The editor holds changes not saved yet; they are saved first. */
  unsaved: boolean;
  /** The editor could not undo the request itself, so a saved version is used. */
  fallback?: boolean;
};

/**
 * Going back to a saved version, from a result card or the version list.
 * Says what else goes back with it before anything happens; nothing is
 * deleted, the current file stays in the version list.
 */
export function RestoreConfirmDialog({
  target,
  busy,
  onCancel,
  onConfirm,
}: {
  target: RestoreTarget | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (target: RestoreTarget) => void;
}) {
  const items: CheckItem[] = [];
  if (target?.fallback)
    items.push({
      tone: "na",
      label: "편집기에서 바로 되돌릴 수 없어서, 요청 전에 저장해 둔 버전으로 돌아가요.",
      evidence: "editor undo refused (document changed or undo history missing)",
    });
  const sentence = target ? impactSentence(target.impact) : null;
  if (sentence) items.push({ tone: "warn", label: sentence, evidence: "version history and request times" });
  if (target?.unsaved)
    items.push({
      tone: "warn",
      label: "저장하지 않은 변경은 먼저 저장한 뒤 함께 되돌아가요.",
      evidence: "editor modified state",
    });
  items.push({
    tone: "ok",
    label: "지금 파일은 버전 기록에 남아서 다시 돌아올 수 있어요.",
    evidence: "restore adds a version; nothing is deleted",
  });
  items.push({ tone: "na", label: "돌아간 뒤 편집기를 다시 불러와요.", evidence: "editor reload after restore" });
  return (
    <Dialog
      open={Boolean(target)}
      title={target ? `${when(target.at)} 상태로 돌아갈까요?` : ""}
      onClose={onCancel}
      dismissible={!busy}
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>
            취소
          </Button>
          <Button variant="primary" icon="restore" loading={busy} onClick={() => target && onConfirm(target)}>
            돌아가기
          </Button>
        </>
      }
    >
      {target ? (
        <>
          <p className="dialog-lead">{target.lead}</p>
          <CheckList items={items} label="돌아가면 일어나는 일" />
        </>
      ) : null}
    </Dialog>
  );
}
