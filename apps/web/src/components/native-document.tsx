"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Banner, Button, ButtonLink, Tabs } from "@/design-system";
import type { AiConnectorConfig } from "@/lib/ai-connector-config";
import type { AvailableModel, ModelSettings } from "@/lib/ai-models";
import type { DocumentSummary, TurnHistoryItem } from "@/lib/history-types";
import { uploadFailure } from "@/lib/upload-reasons";
import { useAiAccount } from "@/lib/use-ai-account";
import {
  NativeWorkspace,
  type NativeLaunch,
  type PendingTurn,
} from "./native-workspace";
import { Composer } from "./workspace/composer";
import { buildConversation } from "./workspace/conversation";
import { ConversationLog } from "./workspace/conversation-log";
import { OpeningFailure, OpeningView } from "./workspace/opening";
import { PhoneSlides } from "./workspace/phone-slides";
import {
  ResultCard,
  RunningCard,
  type CardTurn,
  type EvidencePair,
} from "./workspace/result-card";
import { saveView, WorkspaceTopBar } from "./workspace/top-bar";
import type { PermissionMode } from "./copy";

type LaunchPhase = "checking" | "starting" | "slow" | "failed";

type Failure = {
  title: string;
  body: string;
  retry: boolean;
  download: "current" | "original" | null;
};

const failures: Record<string, Failure> = {
  document_not_found: {
    title: "파일을 찾을 수 없어요",
    body: "삭제됐거나 주소가 바뀌었을 수 있어요. 파일 목록에서 다시 골라 주세요.",
    retry: false,
    download: null,
  },
  document_processing_failed: {
    title: "이 파일을 편집할 수 있게 준비하지 못했어요",
    body: "올린 원본은 그대로 있어요. 원본을 내려받거나, PowerPoint에서 다시 저장한 뒤 올려 보세요.",
    retry: false,
    download: "original",
  },
  browser_office_not_configured: {
    title: "브라우저 편집기가 아직 설정되지 않았어요",
    body: "파일은 안전하게 저장돼 있어요. 서버 설정을 마친 뒤 다시 시도해 주세요.",
    retry: true,
    download: "current",
  },
  network: {
    title: "인터넷 연결이 끊겼어요",
    body: "파일은 안전하게 저장돼 있어요. 연결되면 이어서 열어요.",
    retry: true,
    download: null,
  },
  unknown: {
    title: "편집기에 연결하지 못했어요",
    body: "파일은 안전하게 저장돼 있어요. 편집기 서버가 응답하지 않아요.",
    retry: true,
    download: "current",
  },
};

/** Seconds before opening is tried again on its own. */
const RETRY_SECONDS = 20;

const ordinals = [
  "첫",
  "두",
  "세",
  "네",
  "다섯",
  "여섯",
  "일곱",
  "여덟",
  "아홉",
  "열",
];
function ordinal(count: number) {
  return count <= ordinals.length
    ? `${ordinals[count - 1]} 번째`
    : `${count}번째`;
}

const noop = () => undefined;

/**
 * Opens a document: checks it, starts the editor, and until the editor is
 * ready shows the person's own slides and past requests, and keeps a
 * request written meanwhile to send once the editor is ready.
 */
export default function NativeDocument({
  documentId,
  launchMode,
  aiConnector,
}: {
  documentId: string;
  launchMode: "wopi" | "browser";
  aiConnector: AiConnectorConfig;
}) {
  const [launch, setLaunch] = useState<NativeLaunch | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [tries, setTries] = useState(1);
  const [phase, setPhase] = useState<LaunchPhase>("checking");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [summary, setSummary] = useState<DocumentSummary | null>(null);
  const [history, setHistory] = useState<TurnHistoryItem[]>([]);
  const [offline, setOffline] = useState(false);
  const [retryIn, setRetryIn] = useState<number | null>(null);
  const [phone, setPhone] = useState(false);
  const [phoneSlide, setPhoneSlide] = useState(0);
  const [text, setText] = useState("");
  const [permission, setPermission] = useState<PermissionMode>("selection");
  const [model, setModel] = useState<ModelSettings>();
  const [queued, setQueued] = useState<PendingTurn | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const ai = useAiAccount(aiConnector);
  const launched = Boolean(launch);
  useEffect(() => {
    const narrowScreen = window.matchMedia("(max-width: 760px)");
    const follow = () => setPhone(narrowScreen.matches);
    follow();
    narrowScreen.addEventListener("change", follow);
    return () => narrowScreen.removeEventListener("change", follow);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/documents/${documentId}/summary`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((value: DocumentSummary | null) => {
        if (value) setSummary(value);
      })
      .catch(() => undefined);
    return () => controller.abort();
    // Refetch once the editor is ready to open: a new upload has previews by then.
  }, [documentId, launched, attempt]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/documents/${documentId}/native/turns`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((value: { turns?: TurnHistoryItem[] } | null) => {
        if (value?.turns) setHistory(value.turns);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [documentId]);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const response = await fetch(
        `/api/documents/${documentId}/${launchMode === "browser" ? "browser" : "native"}/launch`,
        {
          method: launchMode === "browser" ? "POST" : "GET",
          cache: "no-store",
          signal,
        },
      );
      const value = (await response.json()) as NativeLaunch & {
        error?: string;
      };
      if (response.ok) {
        setLaunch(value);
        setFailure(null);
        return "ready" as const;
      }
      if (
        response.status === 409 &&
        ["document_processing", "document_not_ready"].includes(
          value.error ?? "",
        )
      ) {
        setPhase("checking");
        return "retry" as const;
      }
      if (response.status === 503 && value.error === "office_editor_starting") {
        setPhase("starting");
        return "retry" as const;
      }
      setPhase("failed");
      setFailure(
        value.error && failures[value.error] ? value.error : "unknown",
      );
      return "failed" as const;
    },
    [documentId, launchMode],
  );
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        if (
          (await load(controller.signal)) === "retry" &&
          !controller.signal.aborted
        )
          timer = setTimeout(check, 2_000);
      } catch (caught) {
        if (!controller.signal.aborted) {
          setPhase("failed");
          setFailure(
            caught instanceof TypeError || !navigator.onLine
              ? "network"
              : "unknown",
          );
        }
      }
    };
    void check();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [load, attempt]);
  useEffect(() => {
    const startedAt = Date.now();
    setElapsedSeconds(0);
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000));
    }, 1_000);
    return () => clearInterval(timer);
  }, [attempt]);
  const retry = useCallback(() => {
    setLaunch(null);
    setFailure(null);
    setRetryIn(null);
    setPhase("checking");
    setAttempt((value) => value + 1);
  }, []);
  const retryAgain = useCallback(() => {
    setTries((value) => value + 1);
    retry();
  }, [retry]);
  const problem = failure ? failures[failure]! : null;
  // Offline: wait for the connection and continue; other retryable
  // failures try again on their own after a short countdown.
  useEffect(() => {
    setOffline(!navigator.onLine);
    const goOffline = () => setOffline(true);
    const goOnline = () => {
      setOffline(false);
      if (failure && failures[failure]?.retry) retryAgain();
    };
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, [failure, retryAgain]);
  useEffect(() => {
    if (!problem?.retry || offline || failure === "network") {
      setRetryIn(null);
      return;
    }
    const deadline = Date.now() + RETRY_SECONDS * 1_000;
    setRetryIn(RETRY_SECONDS);
    const timer = setInterval(
      () => setRetryIn(Math.max(0, Math.ceil((deadline - Date.now()) / 1_000))),
      1_000,
    );
    return () => clearInterval(timer);
  }, [problem, offline, failure]);
  useEffect(() => {
    if (retryIn === 0) retryAgain();
  }, [retryIn, retryAgain]);

  const conversation = useMemo(
    () =>
      buildConversation({
        history,
        messages: queued
          ? [
              {
                id: -1,
                role: "user",
                text: queued.draft,
                tools: [],
                status: "done",
                permission: queued.permission,
                queued: true,
              },
            ]
          : [],
        runs: [],
      }),
    [history, queued],
  );
  const loadModels = useCallback(
    async (signal: AbortSignal): Promise<{ models: AvailableModel[] }> => {
      if (ai.mode === "local") return ai.localRequest("/v1/models");
      const response = await fetch("/api/ai/models", {
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw new Error("models_unavailable");
      return response.json();
    },
    [ai.localRequest, ai.mode],
  );

  const preview = summary?.previews[0] ?? null;
  if (launch)
    return (
      <NativeWorkspace
        key={attempt}
        launch={launch}
        openingPreview={preview}
        openingPreviews={summary?.previews ?? []}
        initialHistory={history}
        initialQueued={queued}
        onReload={retry}
      />
    );
  const reason =
    failure === "document_processing_failed" && summary?.failureCode
      ? uploadFailure(summary.failureCode, summary.fileName, 0).reason
      : null;
  const slow = !problem && elapsedSeconds >= 70;
  const message = offline
    ? "인터넷 연결이 끊겼어요. 연결되면 이어서 열어요."
    : slow
      ? "평소보다 오래 걸려요. 계속 시도하고 있어요."
      : phase === "starting" || elapsedSeconds >= 8
        ? "편집기 준비 중 · 처음 열 때는 1분쯤 걸려요"
        : "파일을 확인하고 있어요";
  const retryLine =
    problem?.retry && retryIn !== null
      ? `${retryIn}초 뒤에 자동으로 다시 시도해요 · ${ordinal(tries + 1)} 시도`
      : problem?.retry && (offline || failure === "network")
        ? "연결되면 자동으로 다시 시도해요"
        : null;
  const failureActions = problem ? (
    <>
      <ButtonLink href="/" variant={problem.retry ? "secondary" : "primary"}>
        파일 목록
      </ButtonLink>
      {problem.download ? (
        <ButtonLink
          icon="download"
          href={`/api/documents/${documentId}/download${problem.download === "original" ? "?source=original" : ""}`}
        >
          {problem.download === "original" ? "원본 내려받기" : "PPTX 내려받기"}
        </ButtonLink>
      ) : null}
      {problem.retry ? (
        <Button variant="primary" icon="refresh" onClick={retryAgain}>
          지금 다시 시도
        </Button>
      ) : null}
    </>
  ) : null;
  const pairsFor = (turn: CardTurn): EvidencePair[] => {
    const saved =
      history.find((item) => item.id === turn.turnId)?.savedPreviews ?? [];
    return (turn.summary?.evidence ?? []).map((item) => {
      const found = saved.find(
        (candidate) => candidate.slideIndex === item.slideIndex,
      );
      return {
        slideIndex: item.slideIndex,
        before: found?.before ?? null,
        after: found?.after ?? null,
        source: "saved",
        framing: "slide",
      };
    });
  };
  return (
    <main className={`ws has-panel ${phone ? "is-phone" : ""}`}>
      <WorkspaceTopBar
        fileName={summary?.fileName ?? ""}
        save={saveView("", false, null)}
        onSave={noop}
        editorReady={false}
        onUndo={noop}
        onRedo={noop}
        versionsOpen={false}
        onVersions={noop}
        onDownload={noop}
        panelOpen
        onTogglePanel={noop}
        disabled
      />
      {phone ? (
        <div className="ws-phone-slides">
          {problem ? (
            <Banner tone={problem.retry ? "warn" : "danger"} role="alert">
              <strong>{problem.title}</strong> {reason ?? ""} {problem.body}
              {retryLine ? <> · {retryLine}</> : null}
            </Banner>
          ) : null}
          <PhoneSlides
            previews={summary?.previews ?? []}
            index={phoneSlide}
            onIndex={setPhoneSlide}
          />
          {problem ? (
            <div className="ws-opening-foot">{failureActions}</div>
          ) : (
            <p className="ws-phone-status" role="status">
              <span className="ds-spinner" aria-hidden="true" />
              {message}
            </p>
          )}
        </div>
      ) : null}
      <section
        className="ws-editor"
        aria-label="프레젠테이션 편집"
        aria-hidden={phone || undefined}
      >
        {problem ? (
          <OpeningFailure title={problem.title} actions={failureActions}>
            {reason ? `${reason} ` : ""}
            {problem.body}
            {retryLine ? (
              <>
                <br />
                <span className="ws-opening-retry ds-tabular">{retryLine}</span>
              </>
            ) : null}
          </OpeningFailure>
        ) : (
          <OpeningView
            preview={preview}
            previews={summary?.previews ?? []}
            message={
              elapsedSeconds >= 10 && !offline
                ? `${message} · ${elapsedSeconds}초`
                : message
            }
            action={
              slow ? (
                <Button size="sm" icon="refresh" onClick={retryAgain}>
                  지금 다시 시도
                </Button>
              ) : null
            }
          />
        )}
      </section>
      <aside className="ws-panel" aria-label="AI와 버전 기록">
        <header className="ws-panel-header">
          <Tabs
            label="패널"
            idPrefix="ws-panel"
            value="ai"
            onChange={noop}
            options={[{ value: "ai", label: "AI", icon: "sparkles" }]}
          />
        </header>
        <div
          className="ws-panel-body"
          id="ws-panel-panel-ai"
          role="tabpanel"
          aria-labelledby="ws-panel-tab-ai"
        >
          {conversation.length ? (
            <ConversationLog
              items={conversation}
              onCancelQueued={() => {
                if (!queued) return;
                setText(queued.draft);
                setQueued(null);
              }}
              renderTurn={(turn) =>
                turn.status === "running" ? (
                  <RunningCard turn={turn} lookingAt={null} onStop={noop} />
                ) : (
                  <ResultCard
                    turn={turn}
                    pairs={pairsFor(turn)}
                    undo={null}
                    onUndo={noop}
                    onRetry={(value, scope) => {
                      setText(value);
                      if (scope) setPermission(scope);
                      input.current?.focus();
                    }}
                  />
                )
              }
            />
          ) : (
            <div className="ai-empty">
              <div>
                <h2>무엇을 바꿀까요?</h2>
                <p>
                  편집기가 열리는 동안 요청을 먼저 적어 둘 수 있어요. 열리는
                  대로 보낼게요.
                </p>
              </div>
            </div>
          )}
        </div>
        <footer className="ws-panel-footer">
          {ai.hasAnyConnection || ai.account ? (
            <Composer
              text={text}
              onText={setText}
              onSubmit={() => {
                if (!text.trim() || queued) return;
                setQueued({ draft: text, permission, model });
                setText("");
              }}
              onStop={() => {
                if (!queued) return;
                setText(queued.draft);
                setQueued(null);
              }}
              busy={Boolean(queued)}
              canSend
              permission={permission}
              onPermission={setPermission}
              model={model}
              onModel={setModel}
              loadModels={loadModels}
              onAttach={noop}
              attaching
              inputRef={input}
              activeProvider={ai.activeProvider}
              rateLimitWarning={
                ai.rateLimitInfo?.isRateLimited && ai.activeProvider === "codex"
                  ? {
                      message: `OpenAI Codex 사용량 한도에 도달했습니다.${
                        ai.rateLimitInfo?.resetAt
                          ? ` (${new Intl.DateTimeFormat("ko-KR", {
                              month: "long",
                              day: "numeric",
                              hour: "numeric",
                              minute: "numeric",
                            }).format(
                              new Date(ai.rateLimitInfo.resetAt * 1000),
                            )} 리셋)`
                          : ""
                      }`,
                    }
                  : null
              }
            />
          ) : (
            <p className="composer-hint">
              AI 연결 전에도 편집기에서 직접 고칠 수 있어요.
            </p>
          )}
        </footer>
      </aside>
    </main>
  );
}
