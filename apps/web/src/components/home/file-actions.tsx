"use client";

import { useEffect, useState } from "react";
import {
  Banner,
  Button,
  Dialog,
  FileMark,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  TextField,
} from "@/design-system";
import type { LibraryDocument } from "@/lib/history-types";

export function documentHref(document: LibraryDocument) {
  return `/documents/${document.id}`;
}

/** Open, download, rename, delete. The same menu on cards and rows. */
export function FileMenu({
  document,
  onRename,
  onDelete,
}: {
  document: LibraryDocument;
  onRename: (document: LibraryDocument) => void;
  onDelete: (document: LibraryDocument) => void;
}) {
  const ready =
    document.status !== "failed" && document.status !== "processing";
  return (
    <Menu
      label={`${document.fileName} 메뉴`}
      placement="below-end"
      width={200}
      trigger={({ open, toggle, ref, menuId }) => (
        <IconButton
          ref={ref}
          icon="more"
          size="sm"
          label={`${document.fileName} 메뉴`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={toggle}
        />
      )}
    >
      {(close) => (
        <>
          {document.status !== "failed" ? (
            <MenuItem
              icon="file"
              title="열기"
              onSelect={() => {
                close();
                window.location.assign(documentHref(document));
              }}
            />
          ) : null}
          <MenuItem
            icon="download"
            title={ready ? "내려받기" : "원본 내려받기"}
            onSelect={() => {
              close();
              window.location.assign(
                `/api/documents/${document.id}/download${ready ? "" : "?source=original"}`,
              );
            }}
          />
          <MenuItem
            icon="edit"
            title="이름 바꾸기"
            onSelect={() => {
              close();
              onRename(document);
            }}
          />
          <MenuSeparator />
          <MenuItem
            icon="trash"
            title="삭제"
            danger
            onSelect={() => {
              close();
              onDelete(document);
            }}
          />
        </>
      )}
    </Menu>
  );
}

const renameErrors: Record<string, string> = {
  invalid_file_name: "이름을 입력해 주세요.",
  file_name_too_long: "이름이 너무 길어요. 180자까지 쓸 수 있어요.",
};

export function RenameDialog({
  document,
  onClose,
  onRenamed,
}: {
  document: LibraryDocument | null;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!document) return;
    setValue(document.fileName.replace(/\.pptx$/i, ""));
    setError("");
  }, [document]);
  async function submit() {
    if (!document) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/documents/${document.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileName: value }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        setError(
          renameErrors[body.error ?? ""] ??
            "이름을 바꾸지 못했어요. 다시 시도해 주세요.",
        );
        return;
      }
      onRenamed();
      onClose();
    } catch {
      setError("네트워크 연결을 확인한 뒤 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={Boolean(document)}
      title="이름 바꾸기"
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            취소
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="rename-file"
            loading={busy}
          >
            바꾸기
          </Button>
        </>
      }
    >
      <form
        id="rename-file"
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <TextField
          label="파일 이름"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          hint="끝의 .pptx는 저절로 붙어요"
          maxLength={175}
          required
          autoFocus
        />
        {error ? (
          <Banner tone="danger" role="alert">
            {error}
          </Banner>
        ) : null}
      </form>
    </Dialog>
  );
}

export function DeleteDialog({
  document,
  onClose,
  onDeleted,
}: {
  document: LibraryDocument | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (document) setError("");
  }, [document]);
  async function remove() {
    if (!document) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/documents/${document.id}`, {
        method: "DELETE",
      });
      if (!response.ok && response.status !== 404) {
        setError("파일을 지우지 못했어요. 다시 시도해 주세요.");
        return;
      }
      onDeleted();
      onClose();
    } catch {
      setError("네트워크 연결을 확인한 뒤 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={Boolean(document)}
      title="파일을 지울까요?"
      onClose={onClose}
      dismissible={!busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            취소
          </Button>
          <Button
            variant="danger"
            icon="trash"
            loading={busy}
            onClick={() => void remove()}
          >
            지우기
          </Button>
        </>
      }
    >
      <div className="file-line">
        <FileMark />
        <div>
          <strong>{document?.fileName}</strong>
          <small>
            {document?.slideCount
              ? `${document.slideCount}장`
              : "PowerPoint 프레젠테이션"}
          </small>
        </div>
        <span />
      </div>
      <p className="dialog-lead">
        파일과 버전 기록, AI 요청 기록이 모두 지워져요. 지운 뒤에는 되돌릴 수
        없어요.
      </p>
      {error ? (
        <Banner tone="danger" role="alert">
          {error}
        </Banner>
      ) : null}
    </Dialog>
  );
}
