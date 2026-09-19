"use client";

import { useEffect, useRef, useState } from "react";
import {
  Banner,
  Button,
  ButtonLink,
  CheckList,
  Dialog,
  FileMark,
  Icon,
  Progress,
  SlideImage,
  type CheckItem,
} from "@/design-system";
import type { DocumentSummary } from "@/lib/history-types";
import { UploadError, uploadDocumentFile } from "@/lib/upload-document";
import {
  precheckUpload,
  uploadFailure,
  type UploadFailure,
} from "@/lib/upload-reasons";
import { fileSize } from "../copy";
import { editScopeLines, fontCheck, renderCheck } from "../document-checks";

type Step =
  | { kind: "uploading"; loaded: number; total: number }
  | { kind: "checking"; id: string }
  | { kind: "done"; id: string; summary: DocumentSummary }
  | { kind: "failed"; failure: UploadFailure };

/**
 * Upload, check, summary, open. The summary says what the server found
 * before the person opens the file. A new `file` starts a new import.
 */
export function ImportDialog({
  file,
  maxBytes,
  onClose,
  onChanged,
  onPickAnother,
}: {
  file: File | null;
  maxBytes: number;
  onClose: () => void;
  /** The library changed (a file was added or finished checking). */
  onChanged: () => void;
  onPickAnother: () => void;
}) {
  const [step, setStep] = useState<Step | null>(null);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  useEffect(() => {
    if (!file) {
      setStep(null);
      return;
    }
    const rejected = precheckUpload(file, maxBytes);
    if (rejected) {
      setStep({
        kind: "failed",
        failure: uploadFailure(rejected, file.name, maxBytes),
      });
      return;
    }
    let active = true;
    let uploading = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setStep({ kind: "uploading", loaded: 0, total: file.size });
    const upload = uploadDocumentFile(file, (loaded, total) => {
      if (active) setStep({ kind: "uploading", loaded, total });
    });
    upload.done
      .then((id) => {
        uploading = false;
        if (!active) return;
        changed.current();
        setStep({ kind: "checking", id });
        const poll = async () => {
          try {
            const response = await fetch(`/api/documents/${id}/summary`, {
              cache: "no-store",
            });
            if (response.ok) {
              const summary = (await response.json()) as DocumentSummary;
              if (!active) return;
              if (summary.status === "failed") {
                changed.current();
                setStep({
                  kind: "failed",
                  failure: uploadFailure(
                    summary.failureCode ?? "document_processing_failed",
                    file.name,
                    maxBytes,
                  ),
                });
                return;
              }
              if (summary.status === "ready") {
                changed.current();
                setStep({ kind: "done", id, summary });
                return;
              }
            }
          } catch {
            // The check keeps running on the server; try again.
          }
          if (active) timer = setTimeout(poll, 1_500);
        };
        void poll();
      })
      .catch((error: unknown) => {
        uploading = false;
        if (!active) return;
        const code =
          error instanceof UploadError ? error.message : "unexpected_error";
        setStep({
          kind: "failed",
          failure: uploadFailure(code, file.name, maxBytes),
        });
      });
    return () => {
      active = false;
      clearTimeout(timer);
      // Closing while bytes are still going up cancels the import; closing
      // while the server checks the file only stops watching.
      if (uploading) upload.abort();
    };
  }, [file, maxBytes]);

  if (!file || !step)
    return (
      <Dialog open={false} title="" onClose={onClose}>
        {null}
      </Dialog>
    );

  if (step.kind === "uploading") {
    const ratio = step.total ? step.loaded / step.total : 0;
    return (
      <Dialog
        open
        title="PowerPoint 가져오기"
        onClose={onClose}
        footer={<Button onClick={onClose}>취소</Button>}
      >
        <div className="file-line">
          <FileMark />
          <div>
            <strong>{file.name}</strong>
            <small>{fileSize(file.size)}</small>
          </div>
          <span className="ds-tabular">{Math.round(ratio * 100)}%</span>
        </div>
        <Progress value={ratio} label="올리는 중" />
        <p className="dialog-note ds-tabular">
          올리는 중 · {fileSize(step.loaded)} / {fileSize(step.total)}
        </p>
      </Dialog>
    );
  }

  if (step.kind === "checking")
    return (
      <Dialog
        open
        title="PowerPoint 가져오기"
        onClose={onClose}
        footer={<Button onClick={onClose}>닫기</Button>}
      >
        <div className="file-line">
          <FileMark />
          <div>
            <strong>{file.name}</strong>
            <small>올림 · {fileSize(file.size)}</small>
          </div>
          <span className="dialog-mark is-ok">
            <Icon name="check" size={16} />
          </span>
        </div>
        <Progress label="파일 확인 중" />
        <p className="dialog-lead" role="status">
          파일 확인 중. 서버에서 슬라이드를 모두 그려 보고, 글꼴을 살피고
          있어요.
        </p>
        <p className="dialog-note">
          처음 여는 파일은 1분쯤 걸릴 수 있어요. 이 창을 닫아도 확인은 계속돼요.
        </p>
      </Dialog>
    );

  if (step.kind === "done") {
    const { summary } = step;
    const count = summary.version?.slideCount ?? summary.previews.length;
    const shown = summary.previews.slice(0, 5);
    const checks = [renderCheck(summary), fontCheck(summary)].filter(
      (item): item is CheckItem => item !== null,
    );
    return (
      <Dialog
        open
        title="가져왔어요"
        leading={
          <span className="dialog-mark is-ok">
            <Icon name="check" size={18} />
          </span>
        }
        onClose={onClose}
        footer={
          <>
            <Button onClick={onClose}>파일 목록</Button>
            <ButtonLink variant="primary" href={`/documents/${step.id}`}>
              열기
            </ButtonLink>
          </>
        }
      >
        {shown.length ? (
          <div className="slide-strip">
            {shown.map((src, index) => (
              <SlideImage
                key={index}
                src={src}
                alt={`${index + 1}번 슬라이드`}
                loading="eager"
              />
            ))}
            {count > shown.length ? <span>+{count - shown.length}</span> : null}
          </div>
        ) : null}
        <p className="dialog-note ds-tabular">
          {count}장 · {fileSize(file.size)}
        </p>
        <CheckList items={checks} label="가져오며 확인한 것" />
        <CheckList items={editScopeLines(summary)} label="고칠 수 있는 것" />
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      title="가져오지 못했어요"
      leading={
        <span className="dialog-mark is-danger">
          <Icon name="close" size={18} />
        </span>
      }
      onClose={onClose}
      footer={
        <Button variant="primary" icon="upload" onClick={onPickAnother}>
          다른 파일 선택
        </Button>
      }
    >
      <div className="file-line">
        <FileMark muted />
        <div>
          <strong>{file.name}</strong>
          <small>{fileSize(file.size)}</small>
        </div>
        <span />
      </div>
      <Banner tone="danger" role="alert">
        {step.failure.reason}
      </Banner>
      <p className="dialog-lead">{step.failure.fix}</p>
    </Dialog>
  );
}
