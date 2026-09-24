"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  ButtonLink,
  EmptyState,
  Icon,
  Menu,
  MenuItem,
  SearchField,
  Segmented,
  SlideImage,
  Spinner,
} from "@/design-system";
import type { AiConnectorConfig } from "@/lib/ai-connector-config";
import type { LibraryDocument } from "@/lib/history-types";
import { failureShort, megabytes } from "@/lib/upload-reasons";
import { useAiAccount } from "@/lib/use-ai-account";
import { AppTop } from "../app-top";
import { relative, subjectParticle } from "../copy";
import {
  DeleteDialog,
  documentHref,
  FileMenu,
  RenameDialog,
} from "./file-actions";
import { ImportDialog } from "./import-dialog";

type Sort = "updated" | "name" | "created";
type View = "grid" | "list";

const sortTitles: Record<Sort, string> = {
  updated: "최근 수정 순",
  name: "이름 순",
  created: "가져온 날 순",
};

const VIEW_KEY = "spellbook.home.view";
const PPTX_ACCEPT =
  ".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation";

function sorted(documents: LibraryDocument[], sort: Sort) {
  const list = [...documents];
  if (sort === "name")
    list.sort((a, b) => a.fileName.localeCompare(b.fileName, "ko"));
  else if (sort === "created")
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  else list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return list;
}

/** Status is shown only when a file needs attention. */
function StatusBadge({ document }: { document: LibraryDocument }) {
  if (document.status === "processing")
    return (
      <Badge>
        <Spinner /> 확인 중…
      </Badge>
    );
  if (document.status === "failed")
    return (
      <Badge tone="warn">
        <Icon name="warning" size={12} /> 열 수 없음
      </Badge>
    );
  return null;
}

function meta(document: LibraryDocument) {
  if (document.status === "processing") return "방금 가져옴";
  if (document.status === "failed") return failureShort(document.failureCode);
  return [
    relative(document.updatedAt),
    document.slideCount ? `${document.slideCount}장` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function Cover({ document }: { document: LibraryDocument }) {
  return (
    <SlideImage
      src={document.coverUrl}
      alt={`${document.fileName} 첫 슬라이드`}
      placeholder={
        document.status === "failed" ? (
          <Icon name="file" size={18} />
        ) : document.status === "processing" ? (
          <Spinner />
        ) : undefined
      }
    />
  );
}

export function HomeScreen({
  email,
  aiConnector,
  maxBytes,
}: {
  email: string;
  aiConnector: AiConnectorConfig;
  maxBytes: number;
}) {
  const ai = useAiAccount(aiConnector);
  const [documents, setDocuments] = useState<LibraryDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("updated");
  const [view, setView] = useState<View>("grid");
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState<File | null>(null);
  const [renaming, setRenaming] = useState<LibraryDocument | null>(null);
  const [deleting, setDeleting] = useState<LibraryDocument | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/documents", { cache: "no-store" });
      if (!response.ok) throw new Error("library_unavailable");
      const value = (await response.json()) as { documents: LibraryDocument[] };
      setDocuments(value.documents);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const warmEditor = useCallback(() => {
    // Opening a document keeps its own retry path if prewarming fails.
    void fetch("/api/office/warm", { method: "POST", keepalive: true }).catch(
      () => undefined,
    );
  }, []);

  useEffect(() => {
    void load();
    warmEditor();
    try {
      const saved = window.localStorage.getItem(VIEW_KEY);
      if (saved === "grid" || saved === "list") setView(saved);
    } catch {
      // A remembered view is a convenience only.
    }
  }, [load, warmEditor]);

  // Keep "checking" cards current while the server works on them.
  const checking = documents.some(
    (document) => document.status === "processing",
  );
  useEffect(() => {
    if (!checking) return;
    const timer = setInterval(() => void load(), 3_000);
    return () => clearInterval(timer);
  }, [checking, load]);

  const startImport = useCallback(
    (file: File) => {
      warmEditor();
      setImporting(file);
    },
    [warmEditor],
  );

  // Drop a PPTX anywhere on the page.
  useEffect(() => {
    const hasFiles = (event: DragEvent) =>
      event.dataTransfer?.types.includes("Files") ?? false;
    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setDragging(true);
    };
    const onOver = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    const onLeave = (event: DragEvent) => {
      if (!event.relatedTarget) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer?.files[0];
      if (file) startImport(file);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [startImport]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sorted(
      needle
        ? documents.filter((document) =>
            document.fileName.toLowerCase().includes(needle),
          )
        : documents,
      sort,
    );
  }, [documents, query, sort]);

  const pickFile = () => fileInput.current?.click();
  const changeView = (next: View) => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Ignore: the view still changes for this visit.
    }
  };

  const limit = `${megabytes(maxBytes)}MB`;
  return (
    <>
      <AppTop email={email} ai={ai}>
        {documents.length ? (
          <SearchField
            label="파일 이름으로 찾기"
            placeholder="파일 이름으로 찾기"
            value={query}
            onChange={setQuery}
          />
        ) : null}
      </AppTop>
      <main className="app-main">
        {loading ? (
          <p className="home-status" role="status">
            <Spinner /> 파일을 불러오고 있어요
          </p>
        ) : loadFailed && !documents.length ? (
          <Banner
            tone="danger"
            role="alert"
            action={
              <Button size="sm" icon="refresh" onClick={() => void load()}>
                다시 불러오기
              </Button>
            }
          >
            파일 목록을 불러오지 못했어요. 네트워크를 확인해 주세요.
          </Banner>
        ) : !documents.length ? (
          <div className="home-first">
            <div>
              <div className={`dropzone ${dragging ? "is-dragging" : ""}`}>
                <span className="ds-empty-mark" aria-hidden="true">
                  <Icon name="upload" size={22} />
                </span>
                <strong>PowerPoint 파일을 끌어 놓거나 선택하세요</strong>
                <Button variant="primary" onClick={pickFile}>
                  파일 선택
                </Button>
                <small>
                  .pptx · {limit}까지 · 옛 형식(.ppt)은 PowerPoint에서 .pptx로
                  저장한 뒤 가져오세요
                </small>
              </div>
              <ol className="how-steps" aria-label="쓰는 순서">
                <li>
                  <i>1</i>
                  <strong>가져오기</strong>
                  가진 파일을 그대로 열어요
                </li>
                <li>
                  <i>2</i>
                  <strong>AI에게 부탁</strong>
                  고친 뒤 화면을 다시 보고 확인해요
                </li>
                <li>
                  <i>3</i>
                  <strong>확인하고 내려받기</strong>
                  바꾼 것과 확인한 것을 보고 받아요
                </li>
              </ol>
            </div>
            <aside className="side-card" aria-label="AI 연결">
              {ai.connectionName ? (
                <>
                  <strong>AI 연결됨 · {ai.connectionName}</strong>
                  <p>파일을 열고 오른쪽 AI 패널에서 바꿀 내용을 부탁하세요.</p>
                </>
              ) : (
                <>
                  <strong>AI 연결</strong>
                  <p>
                    {ai.mode === "local"
                      ? "이 컴퓨터의 연결 앱으로 Codex나 Claude Code 구독을 써요. 처음 한 번만 연결하면 돼요."
                      : "내 ChatGPT(Codex) 구독으로 AI에게 요청해요. 처음 한 번만 연결하면 돼요."}
                  </p>
                  <div>
                    <ButtonLink variant="ai" size="sm" href="/settings">
                      연결하기
                    </ButtonLink>
                  </div>
                  <small className="dialog-note">
                    연결 전에도 직접 편집은 할 수 있어요.
                  </small>
                </>
              )}
            </aside>
          </div>
        ) : (
          <>
            <div className="home-head">
              <h1>파일</h1>
              <span className="home-count ds-tabular">
                {visible.length === documents.length
                  ? `${documents.length}개`
                  : `${visible.length}개 · 전체 ${documents.length}개`}
              </span>
              <div className="home-head-tools">
                <Menu
                  label="정렬"
                  placement="below-end"
                  width={180}
                  trigger={({ open, toggle, ref, menuId }) => (
                    <Button
                      ref={ref}
                      variant="quiet"
                      size="sm"
                      iconEnd="chevronDown"
                      aria-haspopup="menu"
                      aria-expanded={open}
                      aria-controls={open ? menuId : undefined}
                      onClick={toggle}
                    >
                      {sortTitles[sort]}
                    </Button>
                  )}
                >
                  {(close) =>
                    (Object.keys(sortTitles) as Sort[]).map((value) => (
                      <MenuItem
                        key={value}
                        title={sortTitles[value]}
                        checked={value === sort}
                        onSelect={() => {
                          setSort(value);
                          close();
                        }}
                      />
                    ))
                  }
                </Menu>
                <Segmented
                  label="보기 방식"
                  value={view}
                  onChange={changeView}
                  options={[
                    {
                      value: "grid",
                      label: null,
                      icon: "grid",
                      ariaLabel: "격자로 보기",
                    },
                    {
                      value: "list",
                      label: null,
                      icon: "list",
                      ariaLabel: "목록으로 보기",
                    },
                  ]}
                />
                <Button variant="primary" icon="upload" onClick={pickFile}>
                  PowerPoint 가져오기
                </Button>
              </div>
            </div>
            {!visible.length ? (
              <EmptyState icon="search" title="찾는 파일이 없어요">
                ‘{query.trim()}’{subjectParticle(query)} 들어간 파일 이름이
                없어요.
              </EmptyState>
            ) : view === "grid" ? (
              <ul className="file-grid" aria-label="파일">
                {visible.map((document) => (
                  <li key={document.id} className="file-card">
                    <a href={documentHref(document)}>
                      <Cover document={document} />
                      <span
                        className="file-card-name"
                        title={document.fileName}
                      >
                        {document.fileName}
                      </span>
                      <span
                        className={`file-card-meta ${document.status === "failed" ? "is-danger" : ""}`}
                      >
                        {meta(document)}
                      </span>
                    </a>
                    <StatusBadge document={document} />
                    <FileMenu
                      document={document}
                      onRename={setRenaming}
                      onDelete={setDeleting}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="file-list" aria-label="파일">
                {visible.map((document) => (
                  <li key={document.id} className="file-row">
                    <a href={documentHref(document)}>
                      <Cover document={document} />
                      <span className="file-row-text">
                        <span
                          className="file-card-name"
                          title={document.fileName}
                        >
                          {document.fileName}
                        </span>
                        <span
                          className={`file-card-meta ${document.status === "failed" ? "is-danger" : ""}`}
                        >
                          {meta(document)}
                        </span>
                      </span>
                    </a>
                    <StatusBadge document={document} />
                    <FileMenu
                      document={document}
                      onRename={setRenaming}
                      onDelete={setDeleting}
                    />
                  </li>
                ))}
              </ul>
            )}
            <p className="home-note">
              PPTX 파일을 이 화면 아무 곳에나 끌어 놓아도 가져올 수 있어요.
            </p>
          </>
        )}
      </main>
      <input
        ref={fileInput}
        type="file"
        accept={PPTX_ACCEPT}
        className="ds-visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) startImport(file);
        }}
      />
      {dragging && !importing ? (
        <div className="drop-overlay" aria-hidden="true">
          여기에 놓으면 가져와요
        </div>
      ) : null}
      <ImportDialog
        file={importing}
        maxBytes={maxBytes}
        onClose={() => setImporting(null)}
        onChanged={() => void load()}
        onPickAnother={() => {
          setImporting(null);
          pickFile();
        }}
      />
      <RenameDialog
        document={renaming}
        onClose={() => setRenaming(null)}
        onRenamed={() => void load()}
      />
      <DeleteDialog
        document={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => void load()}
      />
    </>
  );
}
