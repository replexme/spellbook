"use client";

import { userFacingError } from "@/lib/user-errors";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Banner, Icon, IconButton, Tabs } from "@/design-system";
import { collaboraCssVariables } from "@/design-system/editor-theme";
import type { AvailableModel, ModelSettings } from "@/lib/ai-models";
import type {
  DocumentSummary,
  TurnHistoryItem,
  VersionHistoryItem,
} from "@/lib/history-types";
import { compactNativeTaskResultForTransport } from "@/lib/native-image-transport";
import {
  consumeNativeStream,
  shouldStreamNativeEvents,
} from "@/lib/native-stream-client";
import type { pollNativeSession } from "@/lib/native-runtime";
import type { TurnSummary } from "@/lib/native-turn-summary";
import { uploadImageAsset, uploadMediaAsset } from "@/lib/upload-image";
import { isEditorAssetId, loadEditorAsset } from "@/lib/editor-asset";
import {
  isBrowserKeyProvider,
  type BrowserKeyProvider,
} from "@/lib/browser-ai/key-store";
import type { BrowserJob } from "@/lib/browser-ai/run-browser-turn";
import { useAiAccount } from "@/lib/use-ai-account";
import type { AiConnectorConfig } from "@/lib/ai-connector-config";
import { CompareDialog, type ComparePair } from "./workspace/compare-dialog";
import { Composer } from "./workspace/composer";
import { ConnectSteps } from "./workspace/connect-steps";
import { buildConversation, type LiveMessage } from "./workspace/conversation";
import { ConversationLog } from "./workspace/conversation-log";
import { when, type PermissionMode } from "./copy";
import { DownloadDialog } from "./workspace/download-dialog";
import { OpeningView } from "./workspace/opening";
import { PhoneSlides } from "./workspace/phone-slides";
import {
  suggestionsFor,
  type EditorSelection,
} from "./workspace/request-scope";
import {
  RestoreConfirmDialog,
  type RestoreTarget,
} from "./workspace/restore-confirm";
import {
  marksFor,
  outcomeOf,
  ResultCard,
  RunningCard,
  type CardTurn,
  type EvidencePair,
} from "./workspace/result-card";
import { saveView, WorkspaceTopBar } from "./workspace/top-bar";
import {
  manualEditRuns,
  restoreImpact,
  savedAfter,
  undoActionFor,
  type TimelineTurn,
  type UndoAction,
} from "./workspace/turn-timeline";
import { restoreLead, type VersionEntry } from "./workspace/version-entries";
import { VersionPanel } from "./workspace/version-panel";
import { WorkspaceAd, workspaceAdEnabled } from "./workspace/workspace-ad";

interface LaunchBase {
  documentId: string;
  fileName: string;
  editorUrl: string;
  accessToken: string;
  expiresAt: number;
  apiBase: string;
  aiConnector: AiConnectorConfig;
}

interface WopiLaunch extends LaunchBase {
  editorKind: "wopi";
}

interface BrowserLaunch extends LaunchBase {
  editorKind: "browser";
  contentApiBase: string;
  revision: string;
  maxBytes: number;
}

export type NativeLaunch = WopiLaunch | BrowserLaunch;

type Message = LiveMessage;
export type PendingTurn = {
  draft: string;
  permission: PermissionMode;
  model?: ModelSettings;
};

const PHONE_QUERY = "(max-width: 760px)";

/** A screenshot from a task result, as an object URL (revoked on unmount). */
function pngUrl(
  image: { pngBytes?: unknown; pngBase64?: unknown } | undefined,
) {
  if (!image) return null;
  try {
    const raw = image.pngBytes;
    const bytes =
      typeof image.pngBase64 === "string"
        ? Uint8Array.from(atob(image.pngBase64), (c) => c.charCodeAt(0))
        : Array.isArray(raw)
          ? Uint8Array.from(raw as number[], (value) => value & 255)
          : raw instanceof Uint8Array
            ? Uint8Array.from(raw)
            : raw instanceof ArrayBuffer
              ? new Uint8Array(raw.slice(0))
              : null;
    return bytes?.length
      ? URL.createObjectURL(new Blob([bytes], { type: "image/png" }))
      : null;
  } catch {
    return null;
  }
}

function lastAssistantIndex(items: Message[]) {
  for (let index = items.length - 1; index >= 0; index -= 1)
    if (items[index]!.role === "assistant") return index;
  return -1;
}

function clip(text: string, limit = 40) {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

// Product UI, also mounted by the isolated native integration harness. The
// launch capability is document-scoped; no provider credential enters here.
export function NativeWorkspace({
  launch,
  openingPreview,
  openingPreviews = [],
  initialHistory = [],
  initialQueued = null,
  onReload,
  onUnsupported,
}: {
  launch: NativeLaunch;
  openingPreview?: string | null;
  /** Saved previews of every slide, shown while the editor opens. */
  openingPreviews?: Array<string | null>;
  /** Requests already loaded by the opening screen. */
  initialHistory?: TurnHistoryItem[];
  /** A request written on the opening screen, sent once the editor is ready. */
  initialQueued?: PendingTurn | null;
  onReload?: () => void;
  /** The browser editor frame found this browser cannot run it. */
  onUnsupported?: () => void;
}) {
  const office = useRef<HTMLIFrameElement>(null),
    form = useRef<HTMLFormElement>(null);
  const port = useRef<MessagePort | null>(null),
    bridgeSession = useRef<string | null>(null),
    submitted = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null),
    bottom = useRef<HTMLDivElement>(null),
    assetInput = useRef<HTMLInputElement>(null);
  const turnRequested = useRef(false),
    /** This editor load saved once before AI edits, so they are checked against its own export. */
    baselineSaved = useRef(false),
    baselineSaveCount = useRef<number | null>(null),
    saveRevision = useRef(0),
    pendingSaveRevision = useRef<number | null>(null),
    pendingTurn = useRef<PendingTurn | null>(null),
    editorModified = useRef(false),
    downloadAfterRevision = useRef<number | null>(null),
    browserOpening = useRef(false),
    browserRevision = useRef(
      launch.editorKind === "browser" ? launch.revision : "",
    ),
    pendingBrowserSave = useRef<{
      requestId: string;
      revision: string | null;
      acknowledgementSent: boolean;
    } | null>(null);
  const lastEventRef = useRef(0);
  const dispatchedLocalJobs = useRef(new Set<string>());
  const assetPayloads = useRef(
    new Map<
      string,
      { mediaType: string; bytes: ArrayBuffer; fileName: string }
    >(),
  );
  const loadingAssets = useRef(new Set<string>());
  /** Calls this page makes to the editor itself (selection, reveal, undo). */
  const hostCalls = useRef(
    new Map<
      string,
      {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >(),
  );
  /** Screenshots the AI looked at, kept only in this page ("taskId:index" → object URL). */
  const imageUrls = useRef(new Map<string, string>());
  const [images, setImages] = useState<Map<string, string>>(new Map());
  const [engineReady, setEngineReady] = useState(false),
    [bridgeReady, setBridgeReady] = useState(false),
    [sessionObserved, setSessionObserved] = useState(false);
  const latestObservation = useRef<Record<string, unknown> | null>(null);
  /** The API-key request running in this page, if any. */
  const browserRun = useRef<AbortController | null>(null);
  const [browserRunning, setBrowserRunning] = useState(false);
  const startBrowserJob = useRef<
    (job: BrowserJob, provider: BrowserKeyProvider, apiKey: string) => void
  >(() => undefined);
  const [phone, setPhone] = useState(
    () =>
      typeof window !== "undefined" && window.matchMedia(PHONE_QUERY).matches,
  );
  // Mounted only in the browser (after the launch request), so the first
  // render can already start with the canvas on narrow screens.
  const [panel, setPanel] = useState(
      () =>
        typeof window === "undefined" ||
        !window.matchMedia(PHONE_QUERY).matches,
    ),
    [panelTab, setPanelTab] = useState<"ai" | "versions">("ai"),
    [text, setText] = useState("");
  useEffect(() => {
    const narrowScreen = window.matchMedia(PHONE_QUERY);
    const follow = () => {
      setPhone(narrowScreen.matches);
      if (narrowScreen.matches) setPanel(false);
    };
    follow();
    narrowScreen.addEventListener("change", follow);
    return () => narrowScreen.removeEventListener("change", follow);
  }, []);
  const [messages, setMessages] = useState<Message[]>([]),
    [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState<PendingTurn | null>(initialQueued);
  const [error, setError] = useState(""),
    [saveState, setSaveState] = useState("저장됨"),
    [savedAt, setSavedAt] = useState<string | null>(null);
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;
  const [uploadingAsset, setUploadingAsset] = useState(false),
    [assetNotice, setAssetNotice] = useState("");
  const [permission, setPermission] = useState<PermissionMode>(
    initialQueued?.permission ?? "document",
  );
  const [model, setModel] = useState<ModelSettings>();
  const [lookingAt, setLookingAt] = useState<{
    slideIndex: number;
    url: string;
  } | null>(null);
  const [history, setHistory] = useState<TurnHistoryItem[]>(initialHistory);
  const [versions, setVersions] = useState<VersionHistoryItem[]>([]),
    [versionsLoading, setVersionsLoading] = useState(false),
    [versionsError, setVersionsError] = useState<string | null>(null);
  const [documentSummary, setDocumentSummary] =
    useState<DocumentSummary | null>(null);
  const [selection, setSelection] = useState<EditorSelection | null>(null);
  const [undone, setUndone] = useState<Map<string, string>>(new Map());
  const [undoing, setUndoing] = useState<string | null>(null);
  const [freshTurns, setFreshTurns] = useState<Set<string>>(new Set());
  const [phoneSlide, setPhoneSlide] = useState(0);
  const [editModeConfirmed, setEditModeConfirmed] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<RestoreTarget | null>(
    null,
  );
  const [editorMounted, setEditorMounted] = useState(true);
  const [compare, setCompare] = useState<{
    title: string;
    subtitle: string;
    pairs: ComparePair[];
    changes?: TurnSummary["changes"];
    imageSource: string;
    turn?: CardTurn;
    restoreEntry?: VersionEntry;
  } | null>(null);
  const [download, setDownload] = useState<{
    summary: DocumentSummary | null;
    loading: boolean;
    busy: boolean;
  } | null>(null);
  const ai = useAiAccount(launch.aiConnector);
  const aiConnected = Boolean(ai.hasAnyConnection || ai.account);
  const isRateLimited = Boolean(
    ai.rateLimitInfo?.isRateLimited && ai.activeProvider === "codex",
  );
  const rateLimitWarning = isRateLimited
    ? {
        message: `OpenAI Codex 사용량 한도에 도달했습니다.${
          ai.rateLimitInfo?.resetAt
            ? ` (${new Intl.DateTimeFormat("ko-KR", {
                month: "long",
                day: "numeric",
                hour: "numeric",
                minute: "numeric",
              }).format(new Date(ai.rateLimitInfo.resetAt * 1000))} 리셋)`
            : ""
        }`,
      }
    : null;
  const origin = new URL(launch.editorUrl).origin;
  const documentBase = `/api/documents/${launch.documentId}`;
  const api = useCallback(
    async (path: string, body?: unknown, signal?: AbortSignal) => {
      const response = await fetch(`${launch.apiBase}/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(launch.accessToken
            ? { authorization: `Bearer ${launch.accessToken}` }
            : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: "no-store",
        signal,
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? "연결을 확인하세요.");
      return value;
    },
    [launch.apiBase, launch.accessToken],
  );
  const documentApi = useCallback(
    async (path: string, init?: RequestInit) => {
      const response = await fetch(`${documentBase}/${path}`, {
        ...init,
        headers: {
          ...(launch.accessToken
            ? { authorization: `Bearer ${launch.accessToken}` }
            : {}),
          ...(init?.body ? { "content-type": "application/json" } : {}),
        },
        cache: "no-store",
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(value.error ?? "request_failed");
      return value;
    },
    [documentBase, launch.accessToken],
  );
  const loadModels = useCallback(
    async (signal: AbortSignal): Promise<{ models: AvailableModel[] }> => {
      // API-key models do not depend on the AI worker being reachable.
      let serverModels: AvailableModel[] = [];
      let failure: unknown = null;
      try {
        const body = (await (ai.mode === "local"
          ? ai.localRequest("/v1/models")
          : api("models", undefined, signal))) as { models?: AvailableModel[] };
        serverModels = body.models ?? [];
      } catch (error) {
        failure = error;
      }
      const models = ai.withBrowserModels(serverModels);
      if (!models.length && failure) throw failure;
      return { models };
    },
    [ai.localRequest, ai.mode, ai.withBrowserModels, api],
  );
  const refreshHistory = useCallback(async () => {
    try {
      const value = (await api("turns")) as { turns: TurnHistoryItem[] };
      setHistory(value.turns);
    } catch {
      // History is additive; the live event stream still renders cards.
    }
  }, [api]);
  const refreshVersions = useCallback(async () => {
    setVersionsLoading(true);
    try {
      const value = (await documentApi("versions")) as {
        versions: VersionHistoryItem[];
      };
      setVersions(value.versions);
      setVersionsError(null);
    } catch (cause) {
      setVersionsError(
        cause instanceof Error ? cause.message : "versions_unavailable",
      );
    } finally {
      setVersionsLoading(false);
    }
  }, [documentApi]);
  const refreshSummary = useCallback(async () => {
    try {
      setDocumentSummary((await documentApi("summary")) as DocumentSummary);
    } catch {
      // Previews and sizes are optional; the editor is the document.
    }
  }, [documentApi]);
  const dispatchLocalJob = useCallback(
    async (job: { jobId?: unknown }) => {
      if (ai.mode !== "local" || typeof job.jobId !== "string")
        throw new Error("invalid_local_native_job");
      if (dispatchedLocalJobs.current.has(job.jobId)) return;
      dispatchedLocalJobs.current.add(job.jobId);
      try {
        await ai.localRequest("/v1/jobs/native", job);
      } catch (error) {
        dispatchedLocalJobs.current.delete(job.jobId);
        throw error;
      }
    },
    [ai.localRequest, ai.mode],
  );
  const dispatchTurn = useCallback(
    async (pending: PendingTurn) => {
      turnRequested.current = true;
      try {
        // An API-key request runs in this page with the key kept here.
        const keyProvider = isBrowserKeyProvider(pending.model?.provider)
          ? pending.model.provider
          : null;
        const apiKey = keyProvider ? ai.browserKey(keyProvider) : null;
        if (keyProvider && !apiKey)
          throw new Error(
            "이 브라우저에 저장된 API 키가 없어요. 설정에서 API 키를 등록해 주세요.",
          );
        browserRun.current?.abort();
        const submitted = await api("chat", {
          text: pending.draft,
          permission: pending.permission,
          modelSettings: pending.model,
          execution: keyProvider ? "browser" : ai.mode,
          initialObservation: !editorModified.current
            ? (latestObservation.current ?? undefined)
            : undefined,
        });
        if (submitted.localJob) await dispatchLocalJob(submitted.localJob);
        if (submitted.browserJob && keyProvider && apiKey)
          startBrowserJob.current(submitted.browserJob, keyProvider, apiKey);
      } catch (cause) {
        if (ai.mode === "local") await api("cancel", {}).catch(() => undefined);
        turnRequested.current = false;
        setBusy(false);
        setText(pending.draft);
        setError(
          userFacingError(
            cause instanceof Error ? cause.message : null,
            "요청을 보내지 못했어요.",
          ),
        );
      }
    },
    [ai.browserKey, ai.mode, api, dispatchLocalJob],
  );
  const sendOffice = useCallback(
    (MessageId: string, Values: unknown = {}) => {
      if (launch.editorKind === "browser") {
        port.current?.postMessage({
          type: "command",
          messageId: MessageId,
          values: Values,
        });
        return;
      }
      office.current?.contentWindow?.postMessage(
        JSON.stringify({ MessageId, SendTime: Date.now(), Values }),
        origin,
      );
    },
    [launch.editorKind, origin],
  );
  const requestSave = useCallback(
    (state = "저장 중…") => {
      pendingSaveRevision.current = saveRevision.current + 1;
      setSaveState(state);
      sendOffice("Action_Save", { Notify: true, DontSaveIfUnmodified: false });
    },
    [sendOffice],
  );
  useEffect(() => {
    if (!engineReady) return;
    const heartbeat = setInterval(() => {
      sendOffice("User_Active");
    }, 20_000);
    return () => clearInterval(heartbeat);
  }, [engineReady, sendOffice]);
  /** Runs one editor operation for this page (not for the AI) and waits for it. */
  const callEditor = useCallback(
    (
      request: Record<string, unknown>,
      timeoutMs = 15_000,
      transfer: Transferable[] = [],
    ) =>
      new Promise<unknown>((resolve, reject) => {
        const channel = port.current;
        if (!channel) {
          reject(new Error("editor_not_connected"));
          return;
        }
        const id = `host-${crypto.randomUUID()}`;
        const timer = setTimeout(() => {
          hostCalls.current.delete(id);
          reject(new Error("editor_timeout"));
        }, timeoutMs);
        hostCalls.current.set(id, { resolve, reject, timer });
        channel.postMessage({ id, request }, transfer);
      }),
    [],
  );
  /** Keeps the task's screenshots in this page; the server drops them when the request ends. */
  const rememberImages = useCallback((taskId: string, list: unknown[]) => {
    let changed = false;
    list.forEach((image, index) => {
      const key = `${taskId}:${index}`;
      if (imageUrls.current.has(key)) return;
      const url = pngUrl(image as { pngBytes?: unknown; pngBase64?: unknown });
      if (!url) return;
      imageUrls.current.set(key, url);
      changed = true;
    });
    if (changed) setImages(new Map(imageUrls.current));
    return imageUrls.current.get(`${taskId}:0`) ?? null;
  }, []);
  startBrowserJob.current = (job, provider, apiKey) => {
    browserRun.current?.abort();
    const abort = new AbortController();
    browserRun.current = abort;
    setBrowserRunning(true);
    // Progress is shown here as it happens; the server only learns the result.
    const live = { text: "", thinking: "", tools: [] as string[] };
    const show = () =>
      setMessages((items) =>
        items.map((message) =>
          message.role === "assistant" && message.turnId === job.turnId
            ? {
                ...message,
                text: live.text,
                thinking: live.thinking || message.thinking,
                tools: [...live.tools],
              }
            : message,
        ),
      );
    // The model runtime loads only when an API-key request is first sent.
    void import("@/lib/browser-ai/run-browser-turn")
      .then(({ runBrowserTurn }) =>
        runBrowserTurn(job, {
          documentId: launch.documentId,
          provider,
          apiKey,
          callEditor,
          onObservation: (taskId, observation) => {
            latestObservation.current = observation;
            const list = observation.images;
            if (!Array.isArray(list) || !list.length) return;
            const url = rememberImages(taskId, list);
            if (url)
              setLookingAt({
                slideIndex: Number(list[0]?.slideIndex) || 0,
                url,
              });
          },
          onText: (delta) => {
            live.text += delta;
            show();
          },
          onThinking: (delta) => {
            live.thinking += delta;
            show();
          },
          onTool: (label) => {
            live.tools.push(label);
            show();
          },
          signal: abort.signal,
        }),
      )
      .catch((cause) => {
        if (abort.signal.aborted) return;
        setError(
          userFacingError(
            cause instanceof Error ? cause.message : null,
            "AI 요청을 시작하지 못했어요.",
          ),
        );
        void api("cancel", {}).catch(() => undefined);
      })
      .finally(() => {
        if (browserRun.current !== abort) return;
        browserRun.current = null;
        // Ends the slow polling below; the next poll brings the result.
        setBrowserRunning(false);
      });
  };
  const deliverTask = useCallback(
    (task: {
      id?: string;
      request?: {
        operation?: string;
        assetId?: string;
        elementId?: string;
        slideIndex?: number;
        expectedRevision?: string;
        expectedSlides?: string;
        permission?: {
          mode?: string;
          slideIndexes?: number[];
          elementIds?: string[];
        };
      };
    }) => {
      const request = task.request;
      const operation = request?.operation ?? "";
      const assetOperations = new Set([
        "insert_image",
        "replace_image",
        "insert_media",
        "replace_media",
      ]);
      if (
        !request ||
        !assetOperations.has(operation) ||
        typeof task.id !== "string"
      ) {
        port.current?.postMessage(task);
        return;
      }
      const assetId = request.assetId ?? "";
      if (!isEditorAssetId(assetId)) {
        void api("result", {
          id: task.id,
          error: "invalid_document_asset",
        }).catch((cause) => setError(cause.message));
        return;
      }
      const deliver = (payload: {
        mediaType: string;
        bytes: ArrayBuffer;
        fileName: string;
      }) => {
        // Transfer a fresh copy because MessagePort detaches transferred buffers.
        // Task redelivery is safe: the extension caches the result by task id.
        const bytes = payload.bytes.slice(0);
        port.current?.postMessage(
          {
            id: task.id,
            request: {
              ...request,
              mediaType: payload.mediaType,
              fileName: payload.fileName,
              assetBytes: bytes,
            },
          },
          [bytes],
        );
      };
      const cached = assetPayloads.current.get(task.id);
      if (cached) {
        deliver(cached);
        return;
      }
      if (loadingAssets.current.has(task.id)) return;
      loadingAssets.current.add(task.id);
      void loadEditorAsset(launch.documentId, assetId)
        .then((payload) => {
          assetPayloads.current.set(task.id!, payload);
          const cachedBytes = () =>
            [...assetPayloads.current.values()].reduce(
              (total, candidate) => total + candidate.bytes.byteLength,
              0,
            );
          while (assetPayloads.current.size > 4 || cachedBytes() > 50_000_000)
            assetPayloads.current.delete(
              assetPayloads.current.keys().next().value!,
            );
          deliver(payload);
        })
        .catch((cause) =>
          api("result", {
            id: task.id,
            error:
              cause instanceof Error ? cause.message : "asset_download_failed",
          }).catch((error) => setError(error.message)),
        )
        .finally(() => loadingAssets.current.delete(task.id!));
    },
    [api, launch.documentId],
  );
  const openBrowserDocument = useCallback(
    async (channel: MessagePort) => {
      if (launch.editorKind !== "browser" || browserOpening.current) return;
      browserOpening.current = true;
      try {
        const response = await fetch(`${launch.contentApiBase}/contents`, {
          cache: "no-store",
        });
        if (!response.ok) {
          const value = await response.json().catch(() => ({}));
          throw new Error(value.error ?? "browser_document_download_failed");
        }
        const revision = response.headers.get("etag") ?? "";
        const contentType = response.headers
          .get("content-type")
          ?.split(";", 1)[0];
        const bytes = await response.arrayBuffer();
        if (
          revision !== launch.revision ||
          contentType !==
            "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
          !bytes.byteLength ||
          bytes.byteLength > launch.maxBytes ||
          new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 2))[0] !== 0x50 ||
          new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 2))[1] !== 0x4b
        )
          throw new Error("browser_document_identity_mismatch");
        browserRevision.current = revision;
        channel.postMessage(
          {
            type: "open",
            requestId: crypto.randomUUID(),
            documentId: launch.documentId,
            fileName: launch.fileName,
            revision,
            maxBytes: launch.maxBytes,
            bytes,
          },
          [bytes],
        );
      } catch (cause) {
        browserOpening.current = false;
        setError(
          cause instanceof Error
            ? cause.message
            : "브라우저에서 PPTX를 열지 못했어요.",
        );
      }
    },
    [launch],
  );
  const saveBrowserDocument = useCallback(
    async (
      channel: MessagePort,
      message: { requestId?: unknown; revision?: unknown; bytes?: unknown },
    ) => {
      if (
        launch.editorKind !== "browser" ||
        typeof message.requestId !== "string" ||
        message.revision !== browserRevision.current ||
        !(message.bytes instanceof ArrayBuffer) ||
        !message.bytes.byteLength ||
        message.bytes.byteLength > launch.maxBytes ||
        pendingBrowserSave.current
      ) {
        channel.postMessage({
          type: "save-result",
          requestId: message.requestId,
          ok: false,
          error: "invalid_browser_save_request",
        });
        return;
      }
      pendingBrowserSave.current = {
        requestId: message.requestId,
        revision: null,
        acknowledgementSent: false,
      };
      pendingSaveRevision.current = saveRevision.current + 1;
      try {
        const response = await fetch(`${launch.contentApiBase}/contents`, {
          method: "PUT",
          headers: {
            "content-type":
              "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "if-match": browserRevision.current,
          },
          body: message.bytes,
          cache: "no-store",
        });
        const value = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new Error(value.error ?? "browser_document_save_failed");
        const revision = response.headers.get("etag") ?? value.revision ?? "";
        if (typeof revision !== "string" || !revision)
          throw new Error("browser_save_revision_missing");
        const pendingRequest = pendingBrowserSave.current;
        if (!pendingRequest || pendingRequest.requestId !== message.requestId)
          return;
        browserRevision.current = revision;
        pendingRequest.revision = revision;
        setSaveState(value.unchanged ? "저장 확인 중…" : "저장 검사 중…");
      } catch (cause) {
        if (pendingBrowserSave.current?.requestId !== message.requestId) return;
        channel.postMessage({
          type: "save-result",
          requestId: message.requestId,
          ok: false,
          error:
            cause instanceof Error
              ? cause.message
              : "browser_document_save_failed",
        });
        pendingSaveRevision.current = null;
        editorModified.current = true;
        setSaveState("저장 실패");
        setError(
          cause instanceof Error
            ? cause.message
            : "브라우저에서 PPTX를 저장하지 못했어요.",
        );
      }
    },
    [launch],
  );
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [messages, history.length]);
  useEffect(() => {
    if (saveState === "저장됨") setSavedAt(when(Date.now()));
  }, [saveState]);
  useEffect(() => {
    if (!busy) setLookingAt(null);
  }, [busy]);
  useEffect(
    () => () => {
      for (const url of imageUrls.current.values()) URL.revokeObjectURL(url);
      imageUrls.current.clear();
      for (const call of hostCalls.current.values()) clearTimeout(call.timer);
      hostCalls.current.clear();
    },
    [],
  );
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin) return;
      if (
        launch.editorKind === "browser" &&
        event.data?.type === "spellbook.browser-office-unsupported"
      ) {
        onUnsupported?.();
        return;
      }
      const browserBridge =
        launch.editorKind === "browser" &&
        event.data?.type === "spellbook.browser-office-ready" &&
        event.data?.protocolVersion === 1 &&
        typeof event.data.bridgeSessionId === "string" &&
        event.data.bridgeSessionId.length > 0;
      const wopiBridge =
        launch.editorKind === "wopi" &&
        event.data?.type === "spellbook.extension-ready";
      if ((browserBridge || wopiBridge) && event.source) {
        const sessionId = browserBridge
          ? event.data.bridgeSessionId
          : typeof event.data.bridgeSessionId === "string"
            ? event.data.bridgeSessionId
            : "legacy";
        if (port.current && bridgeSession.current === sessionId) return;
        port.current?.close();
        port.current = null;
        bridgeSession.current = sessionId;
        setBridgeReady(false);
        const channel = new MessageChannel();
        port.current = channel.port1;
        channel.port1.onmessage = (result) => {
          if (port.current !== channel.port1) return;
          if (result.data?.type === "selection") {
            const value = result.data.value as EditorSelection | undefined;
            if (
              value &&
              Number.isInteger(value.activeSlide) &&
              Array.isArray(value.selected)
            )
              setSelection(value);
            return;
          }
          const hostCall =
            typeof result.data?.id === "string"
              ? hostCalls.current.get(result.data.id)
              : undefined;
          if (hostCall) {
            hostCalls.current.delete(result.data.id);
            clearTimeout(hostCall.timer);
            if (typeof result.data.error === "string")
              hostCall.reject(new Error(result.data.error));
            else hostCall.resolve(result.data.value);
            return;
          }
          if (browserBridge) {
            if (result.data?.type === "ready") {
              void openBrowserDocument(channel.port1);
              return;
            }
            if (result.data?.type === "open-complete") {
              browserOpening.current = false;
              setEngineReady(true);
              setBridgeReady(true);
              setSaveState(
                result.data.recovered ? "복구된 변경 사항 있음" : "저장됨",
              );
              return;
            }
            if (result.data?.type === "modified") {
              editorModified.current = result.data.modified === true;
              setSaveState((current) =>
                result.data.modified
                  ? "변경 사항 있음"
                  : pendingSaveRevision.current !== null
                    ? current
                    : "저장됨",
              );
              return;
            }
            if (result.data?.type === "save") {
              void saveBrowserDocument(channel.port1, result.data);
              return;
            }
            if (result.data?.type === "save-response") {
              if (!result.data.success) {
                if (
                  pendingBrowserSave.current?.requestId ===
                  result.data.requestId
                ) {
                  pendingBrowserSave.current = null;
                  pendingSaveRevision.current = null;
                  downloadAfterRevision.current = null;
                  editorModified.current = true;
                  const waiting = pendingTurn.current;
                  pendingTurn.current = null;
                  if (waiting) {
                    setBusy(false);
                    setText(waiting.draft);
                  }
                }
                setSaveState("저장 실패");
                return;
              }
              const saved = pendingBrowserSave.current;
              if (!saved || saved.requestId !== result.data.requestId) return;
              pendingBrowserSave.current = null;
              pendingSaveRevision.current = null;
              const modified = result.data.modified === true;
              editorModified.current = modified;
              setSaveState(modified ? "변경 사항 있음" : "저장됨");
              const waiting = pendingTurn.current;
              const downloadWaiting = downloadAfterRevision.current !== null;
              if (modified && (waiting || downloadWaiting)) {
                pendingSaveRevision.current = saveRevision.current + 1;
                setSaveState("추가 변경 사항 저장 중…");
                sendOffice("Action_Save", {
                  Notify: true,
                  DontSaveIfUnmodified: false,
                });
              } else if (!modified) {
                if (waiting) {
                  pendingTurn.current = null;
                  void dispatchTurn(waiting);
                }
                if (downloadWaiting) {
                  downloadAfterRevision.current = null;
                  setDownload(null);
                  window.location.assign(
                    `/api/documents/${launch.documentId}/download`,
                  );
                }
              }
              return;
            }
            if (result.data?.type === "error") {
              browserOpening.current = false;
              setError(
                typeof result.data.error === "string"
                  ? result.data.error
                  : "브라우저 편집기에서 오류가 생겼어요.",
              );
              return;
            }
          }
          if (result.data?.type === "ready") {
            setBridgeReady(true);
            port.current?.postMessage({
              id: "warmup-observe",
              request: { operation: "observe" },
            });
            return;
          }
          if (typeof result.data?.id === "string") {
            if (result.data?.value && typeof result.data.value === "object") {
              latestObservation.current = result.data.value as Record<
                string,
                unknown
              >;
            }
            if (result.data.id === "warmup-observe") {
              return;
            }
            const list = result.data?.value?.images;
            if (Array.isArray(list) && list.length) {
              const url = rememberImages(result.data.id, list);
              if (url)
                setLookingAt({
                  slideIndex: Number(list[0]?.slideIndex) || 0,
                  url,
                });
            }
            void api(
              "result",
              compactNativeTaskResultForTransport(result.data),
            ).catch((e) => setError(e.message));
          }
        };
        (event.source as Window).postMessage(
          browserBridge
            ? { type: "spellbook.browser-office-connect", protocolVersion: 1 }
            : {
                type: "spellbook.connect",
                bridgeSessionId: sessionId === "legacy" ? undefined : sessionId,
              },
          origin,
          [channel.port2],
        );
        return;
      }
      if (event.source !== office.current?.contentWindow) return;
      if (event.data?.type === "spellbook.edit-mode") {
        setEditModeConfirmed(event.data.edit === true);
        return;
      }
      let value;
      try {
        value =
          typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      if (value?.MessageId === "App_LoadingStatus") {
        sendOffice("Host_PostmessageReady");
        if (value.Values?.Status === "Document_Loaded") setEngineReady(true);
      }
      if (value?.MessageId === "Action_Save_Resp") {
        if (value.Values?.success) {
          setSaveState("저장 확인 중…");
          if (
            pendingTurn.current &&
            !editorModified.current &&
            baselineSaveCount.current !== null
          ) {
            // Collabora answers before its upload reaches the server, so
            // wait until the server has counted this save. A save identical
            // to the working version leaves the revision unchanged and no
            // poll would release the request: release it here. A new
            // revision is still being checked, and the poll releases the
            // request once that check finishes.
            const expected = pendingSaveRevision.current;
            const before = baselineSaveCount.current;
            baselineSaveCount.current = null;
            void (async () => {
              const deadline = Date.now() + 90_000;
              while (Date.now() < deadline) {
                const saved = (await api("state")) as {
                  saveRevision?: number;
                  editorSaveCount?: number;
                };
                if ((saved.editorSaveCount ?? 0) > before) {
                  if (
                    expected !== null &&
                    typeof saved.saveRevision === "number" &&
                    saved.saveRevision >= expected
                  )
                    return;
                  const waiting = pendingTurn.current;
                  if (!waiting || pendingSaveRevision.current !== expected)
                    return;
                  pendingTurn.current = null;
                  pendingSaveRevision.current = null;
                  setSaveState("저장됨");
                  void dispatchTurn(waiting);
                  return;
                }
                await new Promise((resolve) => setTimeout(resolve, 500));
              }
              throw new Error("editor_save_not_received");
            })().catch((cause) => setError(cause.message));
          }
        } else {
          const waiting = pendingTurn.current;
          pendingTurn.current = null;
          pendingSaveRevision.current = null;
          downloadAfterRevision.current = null;
          setSaveState("저장 실패");
          if (waiting) {
            setBusy(false);
            setText(waiting.draft);
            setError("AI 작업 전에 지금 편집 내용을 저장하지 못했어요.");
          }
        }
      }
      if (value?.MessageId === "Doc_ModifiedStatus") {
        editorModified.current = value.Values?.Modified === true;
        setSaveState((current) =>
          value.Values?.Modified
            ? "변경 사항 있음"
            : pendingSaveRevision.current !== null
              ? current
              : "저장됨",
        );
      }
    };
    window.addEventListener("message", onMessage);
    if (launch.editorKind === "wopi" && !submitted.current && editorMounted) {
      submitted.current = true;
      form.current?.submit();
    }
    return () => window.removeEventListener("message", onMessage);
  }, [
    origin,
    api,
    launch.editorKind,
    openBrowserDocument,
    saveBrowserDocument,
    sendOffice,
    dispatchTurn,
    launch.documentId,
    editorMounted,
    rememberImages,
    onUnsupported,
  ]);
  useEffect(() => {
    if (launch.editorKind !== "wopi" || !engineReady || bridgeReady) return;
    const open = () => {
      // CODE can show a first-run release dialog even when welcome.enable is
      // disabled. Close it through the editor's own message contract so the
      // document canvas, not an upstream product tour, is the first frame.
      sendOffice("welcome-close");
      office.current?.contentWindow?.postMessage(
        { type: "spellbook.open-extension" },
        origin,
      );
    };
    open();
    const timer = setInterval(open, 500);
    return () => clearInterval(timer);
  }, [engineReady, bridgeReady, launch.editorKind, origin, sendOffice]);
  // Phones open the editor in its read-only mobile mode; AI edits and the
  // saves around them need edit mode, so ask for it until it is confirmed.
  useEffect(() => {
    if (
      !phone ||
      launch.editorKind !== "wopi" ||
      !engineReady ||
      editModeConfirmed
    )
      return;
    const ask = () =>
      office.current?.contentWindow?.postMessage(
        { type: "spellbook.ensure-edit" },
        origin,
      );
    ask();
    const timer = setInterval(ask, 1_000);
    return () => clearInterval(timer);
  }, [phone, launch.editorKind, engineReady, editModeConfirmed, origin]);
  useEffect(() => {
    void refreshHistory();
    void refreshVersions();
    void refreshSummary();
  }, [refreshHistory, refreshVersions, refreshSummary]);
  // Each finished save can add a version, previews and a size.
  const lastSaveState = useRef(saveState);
  useEffect(() => {
    const previous = lastSaveState.current;
    lastSaveState.current = saveState;
    if (saveState !== "저장됨" || previous === "저장됨") return;
    void refreshVersions();
    void refreshHistory();
    void refreshSummary();
  }, [saveState, refreshHistory, refreshSummary, refreshVersions]);
  useEffect(() => {
    lastEventRef.current = 0;
  }, [launch.documentId]);
  useEffect(() => {
    if (!bridgeReady) return;
    let stopped = false,
      lastEvent = lastEventRef.current,
      timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    void refreshHistory();
    // A long-lived Cloud Run response is billable for its entire duration.
    // Stream only while an AI turn on the server needs low latency; idle
    // sessions and requests running in this page poll.
    const useStream = shouldStreamNativeEvents(
      busy && !browserRunning,
      launch.accessToken,
      process.env.NEXT_PUBLIC_NATIVE_EVENTS_MODE,
    );
    const handleSnapshot = async (
      response: Awaited<ReturnType<typeof pollNativeSession>>,
    ) => {
      if (stopped) return;
      if (response.localJob && ai.mode === "local" && aiConnected)
        await dispatchLocalJob(response.localJob);
      saveRevision.current =
        response.session?.saveRevision ?? saveRevision.current;
      setSessionObserved(true);
      if (response.session?.status === "validating")
        setSaveState("저장 검사 중…");
      else if (response.session?.status === "active") {
        const completedRevision = pendingSaveRevision.current;
        if (
          completedRevision !== null &&
          saveRevision.current >= completedRevision
        ) {
          const browserSave = pendingBrowserSave.current;
          if (browserSave?.revision) {
            if (!browserSave.acknowledgementSent) {
              browserSave.acknowledgementSent = true;
              port.current?.postMessage({
                type: "save-result",
                requestId: browserSave.requestId,
                ok: true,
                revision: browserSave.revision,
              });
            }
            setSaveState("저장 확인 중…");
          }
          if (browserSave && !browserSave.revision) {
            setSaveState("저장 검사 중…");
            return;
          }
          if (!browserSave) {
            pendingSaveRevision.current = null;
            setSaveState("저장됨");
            const waiting = pendingTurn.current;
            if (waiting) {
              if (editorModified.current) {
                pendingSaveRevision.current = saveRevision.current + 1;
                setSaveState("AI 작업 전 저장 중…");
                sendOffice("Action_Save", {
                  Notify: true,
                  DontSaveIfUnmodified: false,
                });
              } else {
                pendingTurn.current = null;
                void dispatchTurn(waiting);
              }
            }
          }
        } else if (
          pendingSaveRevision.current === null &&
          !editorModified.current
        ) {
          setSaveState("저장됨");
        }
        if (
          pendingBrowserSave.current === null &&
          pendingSaveRevision.current === null &&
          !editorModified.current &&
          downloadAfterRevision.current !== null &&
          saveRevision.current >= downloadAfterRevision.current
        ) {
          downloadAfterRevision.current = null;
          setDownload(null);
          window.location.assign(
            `/api/documents/${launch.documentId}/download`,
          );
        }
      } else if (response.session?.status === "failed") {
        const waiting = pendingTurn.current;
        const browserSave = pendingBrowserSave.current;
        if (browserSave) {
          pendingBrowserSave.current = null;
          editorModified.current = true;
          port.current?.postMessage({
            type: "save-result",
            requestId: browserSave.requestId,
            ok: false,
            error:
              response.session.error ?? "browser_document_validation_failed",
          });
        }
        pendingTurn.current = null;
        pendingSaveRevision.current = null;
        setSaveState("저장 실패");
        setError(response.session.error ?? "저장한 파일을 검사하지 못했어요.");
        if (waiting) {
          setBusy(false);
          setText(waiting.draft);
        }
      }
      if (response.task) deliverTask(response.task);
      let finishedTurn = false;
      for (const event of response.events) {
        lastEvent = event.id;
        lastEventRef.current = lastEvent;
        if (event.type === "start") {
          setBusy(true);
          setMessages((items) => {
            const pending = items.at(-1);
            const assistant: Message = {
              id: event.id,
              role: "assistant",
              text: "",
              tools: [],
              status: "running",
              turnId: event.turnId,
              permission: event.permission ?? pending?.permission,
              at: event.at,
            };
            // The request this page just sent gets its turn id.
            if (
              pending?.role === "user" &&
              !pending.turnId &&
              pending.text === event.text
            )
              return [
                ...items.slice(0, -1),
                { ...pending, turnId: event.turnId, at: event.at },
                assistant,
              ];
            return [
              ...items,
              {
                id: -event.id,
                role: "user",
                text: event.text,
                tools: [],
                status: "done",
                permission: event.permission,
                turnId: event.turnId,
                at: event.at,
              },
              assistant,
            ];
          });
        } else if (event.type === "error") {
          turnRequested.current = false;
          finishedTurn = true;
          setBusy(false);
          // A turn failure belongs on its card; only errors without a turn
          // (older events) fall back to the panel alert.
          if (!event.turnId) setError(event.error);
          setMessages((items) => {
            const index = lastAssistantIndex(items);
            if (index < 0) return items;
            return items.map((m, i) =>
              i === index
                ? {
                    ...m,
                    status: "error",
                    error: event.error,
                    summary: event.summary ?? m.summary,
                    finishedAt: event.at,
                  }
                : m,
            );
          });
        } else if (event.type === "restored") {
          setMessages((items) => [
            ...items,
            {
              id: event.id,
              role: "system",
              text: `${when(event.at)} 이전 버전으로 돌아갔어요`,
              tools: [],
              status: "done",
              at: event.at,
            },
          ]);
        } else if (
          event.type === "undone" &&
          typeof event.turnId === "string"
        ) {
          setUndone((current) => new Map(current).set(event.turnId, event.at));
        } else if (["delta", "tool", "thinking", "done"].includes(event.type)) {
          if (event.type === "done") {
            finishedTurn = true;
            setBusy(false);
            if (event.changed && turnRequested.current) {
              setSaveState("저장 중…");
              sendOffice("Action_Save", {
                Notify: true,
                DontSaveIfUnmodified: false,
              });
            }
            if (turnRequested.current && typeof event.turnId === "string")
              setFreshTurns((current) => new Set(current).add(event.turnId));
            const firstChanged = event.summary?.changedSlides?.[0];
            if (Number.isInteger(firstChanged)) {
              if (turnRequested.current) setPhoneSlide(firstChanged);
              sendOffice("Action_GoToPage", { Page: firstChanged + 1 });
            }
            turnRequested.current = false;
          }
          setMessages((items) => {
            const index = lastAssistantIndex(items);
            if (index < 0) return items;
            return items.map((m, i) =>
              i !== index
                ? m
                : event.type === "delta"
                  ? { ...m, text: m.text + event.delta }
                  : event.type === "thinking"
                    ? {
                        ...m,
                        thinking: (m.thinking ?? "") + (event.thinking ?? ""),
                      }
                    : event.type === "tool"
                      ? { ...m, tools: [...m.tools, event.label] }
                      : {
                          ...m,
                          text: event.text || m.text,
                          status:
                            event.status === "needs_review" ? "review" : "done",
                          summary: event.summary ?? m.summary,
                          changed: event.changed,
                          reviewed: event.reviewed,
                          turnId: event.turnId ?? m.turnId,
                          finishedAt: event.at,
                        },
            );
          });
        }
      }
      if (finishedTurn) {
        void refreshHistory();
        void refreshVersions();
      }
    };
    const poll = async () => {
      try {
        await handleSnapshot(
          await api(`poll?after=${lastEvent}`, undefined, abort.signal),
        );
      } catch (e) {
        if (!stopped)
          setError(e instanceof Error ? e.message : "연결을 확인하세요.");
      }
      // The UI polls quickly only while a turn or save is active. An idle
      // document need not keep a Cloud SQL connection hot four times a second.
      if (!stopped)
        timer = setTimeout(
          poll,
          // A request running in this page shows its own progress; the
          // server only has its start and, after it ends, its result.
          browserRunning
            ? 5_000
            : turnRequested.current ||
                pendingTurn.current ||
                pendingSaveRevision.current !== null ||
                pendingBrowserSave.current
              ? 250
              : 1_500,
        );
    };
    const stream = async () => {
      try {
        await consumeNativeStream(
          `${launch.apiBase}/stream`,
          launch.accessToken,
          lastEvent,
          abort.signal,
          handleSnapshot,
        );
        if (!stopped) timer = setTimeout(stream, 250);
      } catch (e) {
        if (stopped) return;
        setError(e instanceof Error ? e.message : String(e));
        // A failed subscription must not strand saves or tool deliveries.
        void poll();
      }
    };
    if (useStream) void stream();
    else void poll();
    return () => {
      stopped = true;
      abort.abort();
      clearTimeout(timer);
    };
  }, [
    bridgeReady,
    busy,
    browserRunning,
    api,
    deliverTask,
    sendOffice,
    requestSave,
    launch.apiBase,
    launch.accessToken,
    launch.documentId,
    ai.mode,
    aiConnected,
    dispatchLocalJob,
    dispatchTurn,
    refreshHistory,
    refreshVersions,
  ]);
  useEffect(
    () => () => {
      browserRun.current?.abort();
      port.current?.close();
      port.current = null;
      bridgeSession.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!aiConnected) setModel(undefined);
  }, [aiConnected]);
  useEffect(() => {
    if (panel && panelTab === "versions") void refreshVersions();
  }, [panel, panelTab, refreshVersions]);
  const editorAccepts =
    bridgeReady &&
    sessionObserved &&
    (!phone || launch.editorKind !== "wopi" || editModeConfirmed);

  /* Sending: save unsaved edits first so the request starts from a version. */
  const startTurn = useCallback(
    async (pending: PendingTurn) => {
      setError("");
      setBusy(true);
      sendOffice("User_Active");
      setMessages((items) => [
        ...items,
        {
          id: -Date.now(),
          role: "user",
          text: pending.draft,
          tools: [],
          status: "done",
          permission: pending.permission,
          at: new Date().toISOString(),
        },
      ]);
      // A save still in flight (for example the baseline save that starts
      // as the editor becomes ready) must finish first: the server refuses
      // AI edits while it checks a save. The poll sends the request after it.
      if (pendingSaveRevision.current !== null) {
        pendingTurn.current = pending;
        return;
      }
      // The save AI edits are checked against must come from the editor that
      // is open now: a file the editor wrote earlier and opened again exports
      // with different chart ids and layout numbers, which the server's
      // edit-scope check would count as changes the AI made. So the first
      // request of every editor load saves first, even when nothing changed.
      if (
        editorModified.current ||
        (launch.editorKind === "wopi" && !baselineSaved.current)
      ) {
        baselineSaved.current = true;
        pendingTurn.current = pending;
        if (!editorModified.current) {
          const state = (await api("state")) as { editorSaveCount?: number };
          baselineSaveCount.current = state.editorSaveCount ?? 0;
        }
        requestSave("AI 작업 전 저장 중…");
        return;
      }
      await dispatchTurn(pending);
    },
    [api, dispatchTurn, launch.editorKind, requestSave],
  );
  function submit() {
    if (!text.trim() || busy || queued || !aiConnected) return;
    const pending: PendingTurn = { draft: text, permission, model };
    setText("");
    setError("");
    // Written before the editor is ready (on a phone: before it switched
    // to edit mode, which saving needs): keep it and send it once it is.
    if (!editorAccepts) {
      setQueued(pending);
      return;
    }
    void startTurn(pending);
  }
  useEffect(() => {
    if (!queued || !editorAccepts || busy || !aiConnected) return;
    const next = { ...queued, model: queued.model ?? model };
    setQueued(null);
    void startTurn(next);
  }, [queued, editorAccepts, busy, aiConnected, model, startTurn]);
  function cancelQueued() {
    if (!queued) return;
    setText(queued.draft);
    setQueued(null);
  }
  function stop() {
    if (queued) {
      cancelQueued();
      return;
    }
    const waiting = pendingTurn.current;
    if (waiting) {
      pendingTurn.current = null;
      pendingSaveRevision.current = null;
      setBusy(false);
      setText(waiting.draft);
      setError("AI 요청을 취소했어요.");
      return;
    }
    browserRun.current?.abort();
    void api("cancel", {}).catch((e) => setError(e.message));
  }
  async function uploadConversationAsset(file: File) {
    setUploadingAsset(true);
    setAssetNotice("");
    setError("");
    try {
      const uploaded = file.type.startsWith("image/")
        ? await uploadImageAsset(launch.documentId, file)
        : await uploadMediaAsset(launch.documentId, file);
      setAssetNotice(`${uploaded.fileName} 올림`);
      setText((current) =>
        current.trim()
          ? current
          : `올린 ${uploaded.fileName} 파일을 지금 슬라이드에 넣어 줘`,
      );
      input.current?.focus();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "파일을 올리지 못했어요.",
      );
    } finally {
      setUploadingAsset(false);
      if (assetInput.current) assetInput.current.value = "";
    }
  }

  /* Save first, wait for the editor to release the file, restore, reopen. */
  async function restoreTo(versionId: string) {
    if (restoring || busy) return;
    setRestoring(versionId);
    setError("");
    try {
      if (saveStateRef.current !== "저장됨") {
        requestSave();
        const deadline = Date.now() + 60_000;
        while (saveStateRef.current !== "저장됨") {
          if (saveStateRef.current === "저장 실패" || Date.now() > deadline)
            throw new Error(
              "되돌리기 전에 지금 편집 내용을 저장하지 못했어요.",
            );
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
      port.current?.close();
      port.current = null;
      setBridgeReady(false);
      setEngineReady(false);
      setEditorMounted(false);
      if (launch.editorKind === "wopi") {
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const state = (await api("state")) as { editorLocked: boolean };
          if (!state.editorLocked) break;
          await new Promise((resolve) => setTimeout(resolve, 700));
        }
      }
      await documentApi(`versions/${versionId}/restore`, {
        method: "POST",
        body: "{}",
      });
      if (onReload) onReload();
      else window.location.reload();
    } catch (cause) {
      setRestoring(null);
      setEditorMounted(true);
      setError(
        cause instanceof Error
          ? cause.message
          : "이전 버전으로 돌아가지 못했어요.",
      );
    }
  }

  async function openDownload() {
    setDownload({ summary: null, loading: true, busy: false });
    try {
      const summary = (await documentApi("summary")) as DocumentSummary;
      setDownload((current) =>
        current ? { ...current, summary, loading: false } : current,
      );
    } catch {
      setDownload((current) =>
        current ? { ...current, loading: false } : current,
      );
    }
  }
  function startDownload() {
    const downloadUrl = `/api/documents/${launch.documentId}/download`;
    if (saveState === "저장됨") {
      setDownload(null);
      window.location.assign(downloadUrl);
      return;
    }
    const nextRevision = saveRevision.current + 1;
    pendingSaveRevision.current = nextRevision;
    downloadAfterRevision.current = nextRevision;
    setDownload((current) => (current ? { ...current, busy: true } : current));
    setSaveState("다운로드 준비 중…");
    sendOffice("Action_Save", { Notify: true, DontSaveIfUnmodified: false });
  }

  /* ── Conversation ───────────────────────────────────────────────── */
  const historyById = useMemo(
    () => new Map(history.map((turn) => [turn.id, turn])),
    [history],
  );
  const liveMessages = useMemo<Message[]>(
    () =>
      queued
        ? [
            ...messages,
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
        : messages,
    [messages, queued],
  );
  const timelineTurns = useMemo<TimelineTurn[]>(
    () =>
      history.map((turn) => ({
        turnId: turn.id,
        requestText: turn.requestText,
        startedAt: turn.createdAt,
        changed:
          turn.summary?.outcome === "changed" ||
          turn.summary?.outcome === "unverified",
        undone: Boolean(turn.undoneAt ?? undone.get(turn.id)),
      })),
    [history, undone],
  );
  const conversation = useMemo(
    () =>
      buildConversation({
        history,
        messages: liveMessages,
        runs: manualEditRuns(versions, timelineTurns),
        undone,
      }),
    [history, liveMessages, versions, timelineTurns, undone],
  );
  const latestTurnKey = useMemo(() => {
    for (let index = conversation.length - 1; index >= 0; index -= 1) {
      const item = conversation[index]!;
      if (item.kind === "turn") return item.key;
    }
    return null;
  }, [conversation]);

  /** Before/after images: the AI's own while this page has them, else saved previews. */
  const pairsFor = useCallback(
    (turn: CardTurn): EvidencePair[] => {
      const summary = turn.summary;
      if (!summary) return [];
      const saved =
        (turn.turnId
          ? historyById.get(turn.turnId)?.savedPreviews
          : undefined) ?? [];
      return summary.evidence.map((item) => {
        const before = item.before ? (images.get(item.before) ?? null) : null;
        const after = item.after ? (images.get(item.after) ?? null) : null;
        if (before || after)
          return {
            slideIndex: item.slideIndex,
            before,
            after,
            source: "ai" as const,
            framing: item.framing ?? "slide",
            ...(item.stale ? { stale: true } : {}),
          };
        const preview = saved.find(
          (candidate) => candidate.slideIndex === item.slideIndex,
        );
        return {
          slideIndex: item.slideIndex,
          before: preview?.before ?? null,
          after: preview?.after ?? null,
          source: "saved" as const,
          framing: "slide" as const,
        };
      });
    },
    [historyById, images],
  );

  const dirty = [
    "변경 사항 있음",
    "복구된 변경 사항 있음",
    "저장 실패",
  ].includes(saveState);
  const editorLive = engineReady && bridgeReady && !restoring;
  const running =
    busy ||
    Boolean(queued) ||
    messages.some(
      (message) => message.role === "assistant" && message.status === "running",
    );
  const undoFor = (turn: CardTurn, key: string): UndoAction | null =>
    running
      ? null
      : undoActionFor({
          summary: turn.summary,
          outcome: outcomeOf(turn),
          beforeVersionId: turn.beforeVersionId,
          undone: Boolean(turn.undoneAt),
          latest: key === latestTurnKey,
          editorLive,
          changedSince:
            dirty ||
            (turn.turnId
              ? savedAfter(versions, turn.turnId, turn.finishedAt)
              : true),
        });

  /* ── Going back ─────────────────────────────────────────────────── */
  function openTurnRestore(turn: CardTurn, fallback = false) {
    const versionId = turn.beforeVersionId;
    if (!versionId) {
      setError(
        "이 요청 전에 저장한 버전을 찾지 못했어요. 버전 기록에서 골라 주세요.",
      );
      return;
    }
    const at =
      versions.find((version) => version.id === versionId)?.createdAt ??
      turn.startedAt ??
      new Date().toISOString();
    setRestoreTarget({
      versionId,
      at,
      lead: `“${clip(turn.requestText || "AI 요청")}” 요청 전 상태로 돌아가요.`,
      impact: restoreImpact(versions, timelineTurns, at, turn.turnId),
      unsaved: dirty,
      fallback,
    });
  }
  function openVersionRestore(entry: VersionEntry, mode: "this" | "before") {
    const versionId =
      mode === "before" ? entry.parentVersionId : entry.versionId;
    if (!versionId) return;
    const at =
      mode === "before"
        ? (versions.find((version) => version.id === versionId)?.createdAt ??
          entry.at)
        : entry.at;
    setRestoreTarget({
      versionId,
      at,
      lead: restoreLead(entry, mode),
      impact: restoreImpact(
        versions,
        timelineTurns,
        at,
        mode === "before" ? entry.members[0]?.turn?.id : null,
      ),
      unsaved: dirty,
    });
  }
  /** Undo by the plan's rules: the editor's own undo when nothing came after, else a saved version. */
  async function undoTurn(turn: CardTurn, action: UndoAction) {
    if (action.kind === "restore" || !turn.turnId || !turn.summary?.revisions) {
      openTurnRestore(turn);
      return;
    }
    const { revisions, undoSteps } = turn.summary;
    setUndoing(turn.turnId);
    setError("");
    try {
      await callEditor(
        {
          operation: "undo_turn",
          steps: undoSteps,
          expectedRevision: revisions.after,
          targetRevision: revisions.before,
        },
        60_000,
      );
    } catch {
      setUndoing(null);
      openTurnRestore(turn, true);
      return;
    }
    setUndone((current) =>
      new Map(current).set(turn.turnId!, new Date().toISOString()),
    );
    try {
      await api("undo", { turnId: turn.turnId });
    } catch {
      setError(
        "되돌렸지만 버전 기록에 ‘되돌림’으로 남기지 못했어요. 문서는 요청 전 상태예요.",
      );
    }
    requestSave("되돌린 내용 저장 중…");
    setUndoing(null);
  }
  function reveal(slideIndex: number, elementId: string | null) {
    if (phone) {
      setPhoneSlide(slideIndex);
      return;
    }
    sendOffice("Action_GoToPage", { Page: slideIndex + 1 });
    void callEditor({ operation: "reveal", slideIndex, elementId }).catch(
      () => undefined,
    );
  }

  /* ── Keyboard: ⌘S saves; ⌘Z / ⇧⌘Z undo and redo outside text fields ─ */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        if (engineReady && !restoring) requestSave();
        return;
      }
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true']"))
        return;
      if (!engineReady || phone) return;
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        sendOffice("Send_UNO_Command", { Command: ".uno:Undo" });
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        sendOffice("Send_UNO_Command", { Command: ".uno:Redo" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engineReady, phone, requestSave, restoring, sendOffice]);

  function openTurnCompare(turn: CardTurn) {
    const summary = turn.summary;
    if (!summary || !turn.turnId) return;
    const pairs = pairsFor(turn);
    const saved = pairs.some((pair) => pair.source === "saved");
    setCompare({
      title: "무엇이 바뀌었나",
      subtitle: `“${turn.requestText || "AI 요청"}” · AI · ${when(turn.finishedAt ?? turn.startedAt)}`,
      pairs: pairs.map((pair) => ({
        slideIndex: pair.slideIndex,
        before: pair.before,
        after: pair.after,
        marks: marksFor(summary, pair.slideIndex, pair.framing),
      })),
      changes: summary.changes,
      imageSource: saved
        ? "서버에서 그린 저장본 미리보기"
        : pairs.some((pair) => pair.framing === "window")
          ? "AI가 본 편집기 창 전체 · 바뀐 곳 테두리는 슬라이드만 찍은 그림에 그려요"
          : "AI가 편집기에서 본 화면",
      turn,
    });
  }
  function openVersionCompare(entry: VersionEntry) {
    const parent = versions.find(
      (version) => version.id === entry.parentVersionId,
    );
    const count = Math.max(entry.previews.length, parent?.previews.length ?? 0);
    setCompare({
      title: "이전 버전과 비교",
      subtitle: `${entry.title} · ${when(entry.at)}`,
      pairs: Array.from({ length: count }, (_, slideIndex) => ({
        slideIndex,
        before: parent?.previews[slideIndex] ?? null,
        after: entry.previews[slideIndex] ?? null,
        marks: [],
      })),
      imageSource: "서버에서 그린 저장본 미리보기",
      restoreEntry: entry,
    });
  }

  const renderTurn = (turn: CardTurn) => {
    const key = `t:${turn.turnId ?? turn.key}`;
    if (outcomeOf(turn) === "running")
      return <RunningCard turn={turn} lookingAt={lookingAt} onStop={stop} />;
    return (
      <ResultCard
        turn={turn}
        pairs={pairsFor(turn)}
        undo={undoFor(turn, key)}
        undoBusy={undoing === turn.turnId}
        onUndo={(target, action) => void undoTurn(target, action)}
        onCompare={openTurnCompare}
        onRetry={(value, scope) => {
          setText(value);
          if (scope) setPermission(scope);
          input.current?.focus();
        }}
        onReveal={editorLive || phone ? reveal : undefined}
        fresh={Boolean(turn.turnId && freshTurns.has(turn.turnId))}
      />
    );
  };

  const save = saveView(saveState, engineReady, savedAt);
  const panelOpen = phone || panel;
  const phonePreviews = documentSummary?.previews.length
    ? documentSummary.previews
    : openingPreviews;
  const compareUndo = compare?.turn
    ? undoFor(compare.turn, `t:${compare.turn.turnId}`)
    : null;
  return (
    <main
      className={`ws ${panelOpen ? "has-panel" : ""} ${phone ? "is-phone" : ""} ${workspaceAdEnabled ? "has-ad" : ""}`}
    >
      <WorkspaceTopBar
        fileName={launch.fileName}
        save={save}
        onSave={() => requestSave()}
        editorReady={engineReady}
        onUndo={() => sendOffice("Send_UNO_Command", { Command: ".uno:Undo" })}
        onRedo={() => sendOffice("Send_UNO_Command", { Command: ".uno:Redo" })}
        versionsOpen={panelOpen && panelTab === "versions"}
        onVersions={() => {
          if (!phone && panel && panelTab === "versions") setPanel(false);
          else {
            setPanelTab("versions");
            setPanel(true);
          }
        }}
        onDownload={() => void openDownload()}
        panelOpen={panelOpen}
        onTogglePanel={() => {
          if (phone) {
            setPanelTab("ai");
            input.current?.focus();
            return;
          }
          if (panel && panelTab === "ai") setPanel(false);
          else {
            setPanelTab("ai");
            setPanel(true);
          }
        }}
      />
      {phone ? (
        <PhoneSlides
          previews={phonePreviews}
          index={phoneSlide}
          onIndex={setPhoneSlide}
        />
      ) : null}
      <section
        className="ws-editor"
        aria-label="프레젠테이션 편집"
        aria-hidden={phone || undefined}
      >
        {launch.editorKind === "wopi" ? (
          <form
            ref={form}
            target="spellbook-office"
            method="post"
            action={launch.editorUrl}
            hidden
          >
            <input name="access_token" value={launch.accessToken} readOnly />
            <input name="access_token_ttl" value={launch.expiresAt} readOnly />
            <input
              name="css_variables"
              value={collaboraCssVariables()}
              readOnly
            />
            <input
              name="ui_defaults"
              value="UIMode=tabbed;PresentationSidebar=false;"
              readOnly
            />
          </form>
        ) : null}
        {editorMounted ? (
          <iframe
            ref={office}
            name="spellbook-office"
            title="PPT 편집기"
            src={launch.editorKind === "browser" ? launch.editorUrl : undefined}
            allow="clipboard-read; clipboard-write; cross-origin-isolated"
            tabIndex={phone ? -1 : undefined}
          />
        ) : null}
        {!engineReady ? (
          <OpeningView
            preview={restoring ? null : openingPreview}
            previews={restoring ? [] : openingPreviews}
            message={
              restoring
                ? "이전 버전을 불러오고 있어요"
                : "편집기 준비 중 · 처음 열 때는 1분쯤 걸려요"
            }
          />
        ) : null}
      </section>
      {panelOpen ? (
        <aside className="ws-panel" aria-label="AI와 버전 기록">
          <header className="ws-panel-header">
            <Tabs
              label="패널"
              idPrefix="ws-panel"
              value={panelTab}
              onChange={setPanelTab}
              options={[
                { value: "ai", label: "AI", icon: "sparkles" },
                { value: "versions", label: "버전 기록", icon: "clock" },
              ]}
            />
            {phone ? null : (
              <IconButton
                icon="close"
                label="패널 닫기"
                size="sm"
                onClick={() => setPanel(false)}
              />
            )}
          </header>
          {panelTab === "versions" ? (
            <div
              className="ws-panel-body"
              id="ws-panel-panel-versions"
              role="tabpanel"
              aria-labelledby="ws-panel-tab-versions"
            >
              <VersionPanel
                versions={versions}
                loading={versionsLoading}
                error={versionsError}
                restoring={Boolean(restoring)}
                onRestore={openVersionRestore}
                onCompare={openVersionCompare}
                onReload={() => void refreshVersions()}
              />
            </div>
          ) : (
            <>
              <div
                className="ws-panel-body"
                id="ws-panel-panel-ai"
                role="tabpanel"
                aria-labelledby="ws-panel-tab-ai"
              >
                {!aiConnected ? (
                  <div className="ai-empty">
                    {ai.status === "ready" ? (
                      <div>
                        <h2>AI를 연결해 주세요</h2>
                        <p>
                          연결하면 AI가 이 화면을 보고 고친 뒤, 다시 보고
                          확인해요.
                        </p>
                      </div>
                    ) : null}
                    <ConnectSteps ai={ai} />
                  </div>
                ) : null}
                {conversation.length ? (
                  <ConversationLog
                    items={conversation}
                    renderTurn={renderTurn}
                    onCancelQueued={cancelQueued}
                  />
                ) : aiConnected ? (
                  <div className="ai-empty">
                    <div>
                      <h2>무엇을 바꿀까요?</h2>
                      <p>
                        AI는 고친 뒤 화면을 다시 보고 확인해요. 요청마다
                        되돌리기가 있어요.
                      </p>
                    </div>
                    {suggestionsFor(selection).map((group) => (
                      <div key={group.title} className="ai-suggestions">
                        <p>{group.title}</p>
                        {group.items.map((item) => (
                          <button
                            key={item.text}
                            type="button"
                            className="ai-suggestion"
                            onClick={() => {
                              setText(item.text);
                              setPermission(item.scope);
                              input.current?.focus();
                            }}
                          >
                            <span>
                              {item.text}
                              {item.note ? <small> · {item.note}</small> : null}
                            </span>
                            <Icon name="arrowRight" size={14} />
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                ) : null}
                <div ref={bottom} />
              </div>
              <footer className="ws-panel-footer">
                {error ? (
                  <Banner
                    tone="danger"
                    role="alert"
                    action={
                      <IconButton
                        icon="close"
                        label="알림 닫기"
                        size="sm"
                        onClick={() => setError("")}
                      />
                    }
                  >
                    {error}
                  </Banner>
                ) : null}
                {assetNotice ? (
                  <Banner tone="ok" role="status">
                    {assetNotice}
                  </Banner>
                ) : null}
                {aiConnected && engineReady && !bridgeReady ? (
                  <p className="composer-hint" role="status">
                    편집기와 AI를 잇는 중이에요. 요청을 먼저 적어 두면 연결되는
                    대로 보낼게요.
                  </p>
                ) : null}
                {aiConnected ? (
                  <>
                    <input
                      ref={assetInput}
                      className="ds-visually-hidden"
                      type="file"
                      tabIndex={-1}
                      accept="image/png,image/jpeg,audio/mpeg,audio/wav,audio/x-wav,audio/ogg,audio/mp4,video/mp4,video/webm"
                      disabled={busy || uploadingAsset}
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        if (file) void uploadConversationAsset(file);
                      }}
                    />
                    <Composer
                      text={text}
                      onText={setText}
                      onSubmit={submit}
                      onStop={stop}
                      busy={busy || Boolean(queued)}
                      canSend
                      permission={permission}
                      onPermission={setPermission}
                      model={model}
                      onModel={setModel}
                      loadModels={loadModels}
                      onAttach={() => assetInput.current?.click()}
                      attaching={uploadingAsset}
                      inputRef={input}
                      selection={selection}
                      rateLimitWarning={rateLimitWarning}
                      activeProvider={ai.activeProvider}
                    />
                  </>
                ) : (
                  <p className="composer-hint">
                    AI 연결 전에도 편집기에서 직접 고칠 수 있어요.
                  </p>
                )}
              </footer>
            </>
          )}
        </aside>
      ) : null}
      <CompareDialog
        open={Boolean(compare)}
        onClose={() => setCompare(null)}
        title={compare?.title ?? ""}
        subtitle={compare?.subtitle ?? ""}
        pairs={compare?.pairs ?? []}
        changes={compare?.changes}
        imageSource={compare?.imageSource ?? ""}
        onRestore={
          compare?.turn && compareUndo
            ? () => {
                const turn = compare.turn!;
                setCompare(null);
                void undoTurn(turn, compareUndo);
              }
            : compare?.restoreEntry?.parentVersionId
              ? () => {
                  const entry = compare.restoreEntry!;
                  setCompare(null);
                  openVersionRestore(entry, "before");
                }
              : undefined
        }
        restoreLabel={
          compare?.turn
            ? compareUndo?.kind === "native"
              ? "이 요청 되돌리기"
              : "이 요청 전으로 돌아가기"
            : "이 저장 전으로 돌아가기"
        }
      />
      <RestoreConfirmDialog
        target={restoreTarget}
        busy={Boolean(restoring)}
        onCancel={() => setRestoreTarget(null)}
        onConfirm={(target) => {
          setRestoreTarget(null);
          void restoreTo(target.versionId);
        }}
      />
      <DownloadDialog
        open={Boolean(download)}
        onClose={() => setDownload(null)}
        fileName={launch.fileName}
        summary={download?.summary ?? null}
        loading={download?.loading ?? false}
        saved={saveState === "저장됨"}
        busy={download?.busy ?? false}
        waiting={!download?.busy && saveState.endsWith("중…")}
        onDownload={startDownload}
      />
      {workspaceAdEnabled ? <WorkspaceAd /> : null}
    </main>
  );
}
