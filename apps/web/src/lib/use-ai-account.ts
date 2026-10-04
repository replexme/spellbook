"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AiConnectorConfig } from "./ai-connector-config";
import type { AvailableModel } from "./ai-models";
import {
  browserKeyModels,
  isBrowserKeyProvider,
  maskApiKey,
  readBrowserKeys,
  writeBrowserKeys,
  type BrowserKeyProvider,
  type BrowserKeys,
} from "./browser-ai/key-store";
import { checkProviderKey } from "./browser-ai/provider-key-check";
import { readLoginStream } from "./ai-login-stream";
import {
  callLocalConnector,
  LOCAL_CONNECTOR_SESSION_KEY,
  localConnectorOrigin,
  pairLocalConnector,
  readLocalConnectorSession,
  type LocalConnectorSession,
} from "./local-ai-connector";

export const CHATGPT_SECURITY_URL = "https://chatgpt.com/#settings/Security";

export interface AiAccount {
  type: string;
  email?: string | null;
  planType?: string | null;
}

export interface AiDeviceLogin {
  loginId: string;
  verificationUrl: string;
  userCode: string;
}

export interface RateLimitInfo {
  isRateLimited: boolean;
  resetAt: number | null;
  title: string | null;
  description: string | null;
}

// Name of the AI the user can use right now: the active connected provider,
// otherwise any connected one. API-key connections count, not only a
// subscription account.
export function connectedAiName(
  providers: Pick<
    ProviderItem,
    "id" | "displayName" | "connected" | "isActive"
  >[],
  subscriptionRuntimeName?: string | null,
): string | null {
  const connection =
    providers.find((provider) => provider.connected && provider.isActive) ??
    providers.find((provider) => provider.connected);
  if (!connection) return null;
  return connection.id === "codex" && subscriptionRuntimeName
    ? subscriptionRuntimeName
    : connection.displayName;
}

export interface ProviderItem {
  id:
    | "codex"
    | "claude_code"
    | "openai_api"
    | "anthropic_api"
    | "gemini_api"
    | "openrouter_api";
  displayName: string;
  type: "subscription" | "api_key";
  connected: boolean;
  isActive: boolean;
  account?: AiAccount | null;
  maskedKey?: string | null;
  rateLimitInfo?: RateLimitInfo | null;
}

type AccountResponse = {
  account?: { account?: AiAccount | null } | null;
  activeProvider?: string;
  connectedAt?: string | null;
  runtime?: {
    provider: string;
    displayName: string;
    runtime: string;
    version: string;
  };
  rateLimits?: any;
  rateLimitInfo?: RateLimitInfo | null;
  /** The account the browser's API keys are stored under. */
  keyScope?: string;
  /** The Claude subscription visible to the selected connector, if any. */
  claude?: { account?: AiAccount | null } | null;
};

export interface ClaudeSignIn {
  verificationUrl: string;
  loginId: string;
}

// The code Claude's sign-in page shows after approval: "<code>#<state>".
const CLAUDE_CODE = /^[A-Za-z0-9_\-.~]{8,}#[A-Za-z0-9_\-.~]{8,}$/u;

export function looksLikeClaudeCode(text: string): boolean {
  return CLAUDE_CODE.test(text.trim());
}

const LOGIN_WINDOW = "popup,width=520,height=760";

/** Copies text inside the click that asked for it, before a window opens. */
function copyNow(text: string): boolean {
  try {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    const copied = document.execCommand("copy");
    field.remove();
    return copied;
  } catch {
    return false;
  }
}

/** A sign-in window opened inside the click, shown while its page loads. */
function openLoginWindow(name: string, url?: string): Window | null {
  const opened = window.open(url ?? "", name, LOGIN_WINDOW);
  if (opened && !url) {
    try {
      opened.document.title = "Spellbook";
      opened.document.body.style.font = "16px system-ui, sans-serif";
      opened.document.body.style.padding = "2rem";
      opened.document.body.textContent = "로그인 화면을 여는 중이에요…";
    } catch {
      // Another page already loaded in the window.
    }
  }
  return opened;
}

const CHATGPT_LOGIN_ERRORS: Record<string, string> = {
  chatgpt_login_expired:
    "연결 시간이 지났어요. ‘연결 코드 받기’를 다시 눌러 새 코드로 시도해 주세요.",
  chatgpt_login_failed:
    "ChatGPT에서 승인이 끝나지 않았어요. 보안 설정에서 ‘Codex용 장치 코드 인증’이 켜져 있는지 확인한 뒤 다시 시도해 주세요.",
};

const CLAUDE_LOGIN_ERRORS: Record<string, string> = {
  claude_login_expired:
    "로그인 시간이 지났어요. ‘Claude로 로그인’을 다시 눌러 주세요.",
  claude_login_code_invalid:
    "코드가 맞지 않아요. Claude 화면에 나온 코드를 그대로 복사해 주세요.",
  claude_login_failed:
    "Claude 로그인을 마치지 못했어요. ‘Claude로 로그인’을 다시 눌러 주세요.",
  claude_login_unavailable:
    "Claude 로그인을 시작하지 못했어요. 잠시 뒤 다시 시도해 주세요.",
};

function bounceToLogin() {
  if (typeof window !== "undefined") {
    const path = window.location.pathname + window.location.search;
    window.location.href = `/auth/login?redirect=${encodeURIComponent(path)}`;
  }
}

export function useAiAccount(config: AiConnectorConfig) {
  const connectorOrigin = localConnectorOrigin(config);
  const [accountResponse, setAccountResponse] =
    useState<AccountResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [deviceLogin, setDeviceLogin] = useState<AiDeviceLogin | null>(null);
  const [message, setMessage] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [localSession, setLocalSession] =
    useState<LocalConnectorSession | null>(null);
  const [waitingForBrowserLogin, setWaitingForBrowserLogin] = useState(false);
  const [waitingForClaudeLogin, setWaitingForClaudeLogin] = useState(false);
  const [keyScope, setKeyScope] = useState<string | null>(null);
  const [claudeSignIn, setClaudeSignIn] = useState<ClaudeSignIn | null>(null);
  const [claudeMessage, setClaudeMessage] = useState("");
  const [claudeCompleting, setClaudeCompleting] = useState(false);
  // An older connector that cannot report the end of a sign-in: the page
  // watches the account status instead.
  const [watchStatus, setWatchStatus] = useState(false);
  const loginWindow = useRef<Window | null>(null);
  const loginRun = useRef<AbortController | null>(null);
  const closeLoginWindow = useCallback(() => {
    try {
      loginWindow.current?.close();
    } catch {
      // Already closed.
    }
    loginWindow.current = null;
  }, []);
  // Leaving the page ends a sign-in in progress.
  useEffect(() => () => loginRun.current?.abort(), []);
  const [browserKeys, setBrowserKeys] = useState<BrowserKeys>(() =>
    readBrowserKeys(null),
  );
  useEffect(() => {
    const refresh = () => setBrowserKeys(readBrowserKeys(keyScope));
    refresh();
    // A key added in another tab (for example the settings page) applies here.
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, [keyScope]);

  const load = useCallback(async () => {
    try {
      if (connectorOrigin) {
        // Keys are kept per Spellbook account even when the subscription
        // runs in the local connector.
        void fetch("/api/ai/account/status", { cache: "no-store" })
          .then((response) => (response.ok ? response.json() : null))
          .then((value: AccountResponse | null) =>
            setKeyScope(value?.keyScope ?? null),
          )
          .catch(() => undefined);
        const session = readLocalConnectorSession(window.sessionStorage);
        setLocalSession(session);
        if (!session) {
          setAccountResponse(null);
          setStatus("ready");
          return null;
        }
        const value = await callLocalConnector<AccountResponse>(
          connectorOrigin,
          "/v1/account/status",
          session,
        );
        setAccountResponse(value);
        setStatus("ready");
        if (value.account?.account) {
          setWaitingForBrowserLogin(false);
          setMessage("");
        }
        if (value.claude?.account) {
          setWaitingForClaudeLogin(false);
          setClaudeMessage("");
        }
        return value;
      }
      const response = await fetch("/api/ai/account/status", {
        cache: "no-store",
      });
      if (response.status === 401) {
        bounceToLogin();
        return null;
      }
      if (!response.ok) throw new Error("account_status_unavailable");
      const value = (await response.json()) as AccountResponse;
      setAccountResponse(value);
      setKeyScope(value.keyScope ?? null);
      setStatus("ready");
      if (value.account?.account) {
        setDeviceLogin(null);
        setMessage("");
      }
      return value;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "";
      if (
        connectorOrigin &&
        /connector_(?:session|required)|invalid_connector_session/.test(msg)
      ) {
        window.sessionStorage.removeItem(LOCAL_CONNECTOR_SESSION_KEY);
        setLocalSession(null);
        setAccountResponse(null);
        setStatus("ready");
      } else setStatus("error");
      return null;
    }
  }, [connectorOrigin]);

  useEffect(() => {
    void load();
    const refresh = () => void load();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [load]);

  useEffect(() => {
    if (!watchStatus && !waitingForBrowserLogin && !waitingForClaudeLogin)
      return;
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [watchStatus, waitingForBrowserLogin, waitingForClaudeLogin, load]);

  useEffect(() => {
    if (!waitingForClaudeLogin) return;
    const timer = window.setTimeout(() => {
      setWaitingForClaudeLogin(false);
      setClaudeMessage(
        "Claude Code 로그인이 완료되지 않았어요. 연결 확인을 눌러 다시 시도해 주세요.",
      );
    }, 5 * 60_000);
    return () => window.clearTimeout(timer);
  }, [waitingForClaudeLogin]);

  const connect = useCallback(async () => {
    setConnecting(true);
    setMessage("");
    setCodeCopied(false);
    try {
      if (connectorOrigin) {
        const session = await pairLocalConnector(connectorOrigin);
        setLocalSession(session);
        setWaitingForBrowserLogin(true);
        setMessage("AI 계정 연결 완료를 기다리고 있습니다.");
        await load();
        return;
      }
      loginRun.current?.abort();
      const run = new AbortController();
      loginRun.current = run;
      setDeviceLogin(null);
      setWatchStatus(false);
      const response = await fetch("/api/ai/account/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: run.signal,
      });
      if (response.status === 401) {
        bounceToLogin();
        return;
      }
      if (!response.ok) {
        setMessage(
          "ChatGPT 연결을 시작하지 못했어요. 잠시 뒤 다시 시도해 주세요.",
        );
        return;
      }
      await new Promise<void>((started) => {
        void readLoginStream(response, (value) => {
          setDeviceLogin({
            loginId: String(value.loginId ?? ""),
            verificationUrl: String(value.verificationUrl ?? ""),
            userCode: String(value.userCode ?? ""),
          });
          started();
        })
          .then(async (finished) => {
            if (loginRun.current !== run) return;
            if (finished.pending) {
              setWatchStatus(true);
              return;
            }
            closeLoginWindow();
            setDeviceLogin(null);
            if (finished.connected) {
              setMessage("");
              await load();
            } else
              setMessage(
                CHATGPT_LOGIN_ERRORS[finished.error ?? ""] ??
                  "ChatGPT 연결을 마치지 못했어요. 다시 시도해 주세요.",
              );
          })
          .catch(() => {
            if (loginRun.current !== run || run.signal.aborted) return;
            setDeviceLogin(null);
            setMessage(
              "ChatGPT 연결이 중간에 끊겼어요. ‘연결 코드 받기’를 다시 눌러 주세요.",
            );
          })
          .finally(started);
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "";
      setMessage(
        connectorOrigin
          ? reason === "local_connector_popup_blocked"
            ? "브라우저에서 연결 승인 창을 허용한 뒤 다시 시도해 주세요."
            : "이 컴퓨터에서 Spellbook AI 연결 앱을 실행한 뒤 다시 시도해 주세요."
          : "OpenAI 연결 상태를 확인하지 못했습니다. 다시 시도해 주세요.",
      );
    } finally {
      setConnecting(false);
    }
  }, [closeLoginWindow, connectorOrigin, load]);

  const copyCode = useCallback(async () => {
    if (!deviceLogin) return;
    await navigator.clipboard.writeText(deviceLogin.userCode);
    setCodeCopied(true);
  }, [deviceLogin]);

  /**
   * Copies the code and opens ChatGPT's code page in a small window, in the
   * same click: the person only pastes the code there and approves. The
   * window closes by itself once the connection is saved.
   */
  const openChatGptSignIn = useCallback(() => {
    if (!deviceLogin) return;
    const copied = copyNow(deviceLogin.userCode);
    loginWindow.current = openLoginWindow(
      "spellbook-chatgpt-login",
      deviceLogin.verificationUrl,
    );
    if (copied) setCodeCopied(true);
    else
      void navigator.clipboard
        ?.writeText(deviceLogin.userCode)
        .then(() => setCodeCopied(true))
        .catch(() => undefined);
    return Boolean(loginWindow.current);
  }, [deviceLogin]);

  const disconnect = useCallback(async () => {
    if (connectorOrigin) {
      try {
        if (localSession)
          await callLocalConnector(
            connectorOrigin,
            "/v1/pairings/revoke",
            localSession,
          );
      } finally {
        window.sessionStorage.removeItem(LOCAL_CONNECTOR_SESSION_KEY);
        setLocalSession(null);
        setAccountResponse(null);
        setDeviceLogin(null);
        setWaitingForBrowserLogin(false);
        setWaitingForClaudeLogin(false);
        setClaudeMessage("");
      }
    } else await fetch("/api/ai/account/logout", { method: "POST" });
    loginRun.current?.abort();
    setAccountResponse(null);
    setDeviceLogin(null);
    await load();
  }, [connectorOrigin, localSession, load]);

  // A key saved before the page has learned the account waits for it.
  const accountScope = useCallback(
    async () => keyScope ?? (await load())?.keyScope ?? null,
    [keyScope, load],
  );
  const storeKeys = useCallback((scope: string | null, next: BrowserKeys) => {
    if (!scope) throw new Error("로그인 상태를 확인한 뒤 다시 시도해 주세요.");
    try {
      writeBrowserKeys(scope, next);
    } catch {
      throw new Error(
        "이 브라우저에 API 키를 저장할 수 없습니다. 개인정보 보호 모드나 사이트 데이터 차단을 확인해 주세요.",
      );
    }
    setBrowserKeys(next);
  }, []);

  // API keys stay in this browser: checked against the provider from here
  // and never sent to Spellbook's servers.
  const configureApiKey = useCallback(
    async (provider: BrowserKeyProvider, apiKey: string, active = true) => {
      await checkProviderKey(provider, apiKey);
      const scope = await accountScope();
      const current = readBrowserKeys(scope);
      storeKeys(scope, {
        active: active ? provider : current.active,
        keys: { ...current.keys, [provider]: apiKey.trim() },
      });
    },
    [accountScope, storeKeys],
  );

  const deleteApiKey = useCallback(
    async (provider: string) => {
      if (!isBrowserKeyProvider(provider)) return;
      const scope = await accountScope();
      const current = readBrowserKeys(scope);
      const { [provider]: _removed, ...keys } = current.keys;
      storeKeys(scope, {
        active: current.active === provider ? null : current.active,
        keys,
      });
    },
    [accountScope, storeKeys],
  );

  const selectProvider = useCallback(
    async (provider: string) => {
      const scope = await accountScope();
      const current = readBrowserKeys(scope);
      storeKeys(scope, {
        ...current,
        active:
          isBrowserKeyProvider(provider) ||
          provider === "codex" ||
          provider === "claude_code"
            ? provider
            : null,
      });
    },
    [accountScope, storeKeys],
  );

  /** The stored key for a provider, read when a request runs in this browser. */
  const browserKey = useCallback(
    (provider: BrowserKeyProvider) => browserKeys.keys[provider] ?? null,
    [browserKeys],
  );
  /** Server models plus the models this browser's API keys can run. */
  const withBrowserModels = useCallback(
    (models: AvailableModel[]) => [...models, ...browserKeyModels(browserKeys)],
    [browserKeys],
  );

  // In local mode, pairing only grants this browser access to the official
  // Claude Code login already held on the person's computer.
  const connectClaude = useCallback(async () => {
    setClaudeMessage("");
    if (connectorOrigin) {
      let startingClaudeLogin = false;
      try {
        const session =
          localSession ?? (await pairLocalConnector(connectorOrigin, "claude"));
        setLocalSession(session);
        const value = await callLocalConnector<AccountResponse>(
          connectorOrigin,
          "/v1/account/status",
          session,
        );
        setAccountResponse(value);
        setStatus("ready");
        if (!value.claude?.account) {
          startingClaudeLogin = true;
          await callLocalConnector(
            connectorOrigin,
            "/v1/claude/login",
            session,
          );
          setWaitingForClaudeLogin(true);
          setClaudeMessage(
            "공식 Claude Code 로그인 화면에서 승인을 기다리고 있어요.",
          );
        }
      } catch {
        setClaudeMessage(
          startingClaudeLogin
            ? "Claude Code 로그인 창을 열지 못했어요. 이 컴퓨터에 Claude Code가 설치돼 있는지 확인해 주세요."
            : "이 컴퓨터에서 Spellbook 연결 앱을 실행하고 새 창에서 연결을 허용해 주세요.",
        );
      }
      return;
    }
    // The window opens inside the click (so it is not blocked) and moves to
    // Claude's sign-in page as soon as the sign-in has started.
    loginRun.current?.abort();
    const run = new AbortController();
    loginRun.current = run;
    closeLoginWindow();
    loginWindow.current = openLoginWindow("spellbook-claude-login");
    setClaudeSignIn(null);
    let response: Response;
    try {
      response = await fetch("/api/ai/account/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "claude_code" }),
        signal: run.signal,
      });
    } catch {
      closeLoginWindow();
      setClaudeMessage(CLAUDE_LOGIN_ERRORS.claude_login_unavailable);
      return;
    }
    if (response.status === 401) {
      closeLoginWindow();
      bounceToLogin();
      return;
    }
    if (!response.ok) {
      closeLoginWindow();
      setClaudeMessage(CLAUDE_LOGIN_ERRORS.claude_login_unavailable);
      return;
    }
    await new Promise<void>((started) => {
      void readLoginStream(response, (value) => {
        const signIn = {
          verificationUrl: String(value.verificationUrl ?? ""),
          loginId: String(value.loginId ?? ""),
        };
        setClaudeSignIn(signIn);
        const opened = loginWindow.current;
        if (opened && !opened.closed) opened.location.href = signIn.verificationUrl;
        started();
      })
        .then(async (finished) => {
          if (loginRun.current !== run) return;
          closeLoginWindow();
          setClaudeSignIn(null);
          if (finished.connected) {
            setClaudeMessage("");
            await load();
          } else
            setClaudeMessage(
              CLAUDE_LOGIN_ERRORS[finished.error ?? ""] ??
                CLAUDE_LOGIN_ERRORS.claude_login_failed,
            );
        })
        .catch(() => {
          if (loginRun.current !== run || run.signal.aborted) return;
          closeLoginWindow();
          setClaudeSignIn(null);
          setClaudeMessage(CLAUDE_LOGIN_ERRORS.claude_login_expired);
        })
        .finally(started);
    });
  }, [closeLoginWindow, connectorOrigin, load, localSession]);

  /** Opens Claude's sign-in page again if its window was closed. */
  const reopenClaudeSignIn = useCallback(() => {
    if (!claudeSignIn) return;
    loginWindow.current = openLoginWindow(
      "spellbook-claude-login",
      claudeSignIn.verificationUrl,
    );
  }, [claudeSignIn]);

  const completeClaude = useCallback(
    async (code: string) => {
      if (!claudeSignIn || claudeCompleting) return;
      setClaudeMessage("");
      setClaudeCompleting(true);
      try {
        const response = await fetch("/api/ai/account/login/complete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            code: code.trim(),
            loginId: claudeSignIn.loginId,
          }),
        });
        if (!response.ok) {
          const value = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          setClaudeMessage(
            CLAUDE_LOGIN_ERRORS[value.error ?? ""] ??
              CLAUDE_LOGIN_ERRORS.claude_login_failed,
          );
          return;
        }
        closeLoginWindow();
        setClaudeSignIn(null);
        await load();
      } catch {
        setClaudeMessage(CLAUDE_LOGIN_ERRORS.claude_login_failed);
      } finally {
        setClaudeCompleting(false);
      }
    },
    [claudeCompleting, claudeSignIn, closeLoginWindow, load],
  );

  /**
   * Reads the code the person copied on Claude's page (the browser may ask
   * once to allow this) and connects; nothing has to be typed.
   */
  const pasteClaudeCode = useCallback(async (): Promise<boolean> => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!looksLikeClaudeCode(text)) {
        setClaudeMessage(
          "복사한 내용이 Claude 코드가 아니에요. Claude 화면에서 코드 옆 ‘복사’를 누른 뒤 다시 눌러 주세요.",
        );
        return false;
      }
      await completeClaude(text);
      return true;
    } catch {
      setClaudeMessage(
        "브라우저가 붙여넣기를 막았어요. 아래 칸에 코드를 붙여 넣어 주세요.",
      );
      return false;
    }
  }, [completeClaude]);

  // Coming back from Claude's window with the code already copied connects
  // by itself where this site may already read the clipboard; elsewhere the
  // person presses one button (or pastes into the field).
  useEffect(() => {
    if (!claudeSignIn) return;
    const check = async () => {
      try {
        const permission = await navigator.permissions?.query({
          name: "clipboard-read" as PermissionName,
        });
        if (permission?.state !== "granted") return;
        const text = (await navigator.clipboard.readText()).trim();
        if (looksLikeClaudeCode(text)) await completeClaude(text);
      } catch {
        // Not supported here; the button and the field remain.
      }
    };
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [claudeSignIn, completeClaude]);

  const disconnectClaude = useCallback(async () => {
    if (connectorOrigin) {
      try {
        if (localSession)
          await callLocalConnector(
            connectorOrigin,
            "/v1/pairings/revoke",
            localSession,
          );
      } finally {
        window.sessionStorage.removeItem(LOCAL_CONNECTOR_SESSION_KEY);
        setLocalSession(null);
        setAccountResponse(null);
        setClaudeMessage("");
        setWaitingForBrowserLogin(false);
        setWaitingForClaudeLogin(false);
      }
      return;
    }
    loginRun.current?.abort();
    await fetch("/api/ai/account/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "claude_code" }),
    });
    await load();
  }, [connectorOrigin, localSession, load]);

  const localRequest = useCallback(
    async <T>(path: string, body?: unknown): Promise<T> => {
      if (!connectorOrigin || !localSession)
        throw new Error("local_connector_not_paired");
      return callLocalConnector<T>(connectorOrigin, path, localSession, body);
    },
    [connectorOrigin, localSession],
  );

  const codexAccount = accountResponse?.account?.account ?? null;
  const codexConnected = Boolean(codexAccount);
  const rateLimitInfo = accountResponse?.rateLimitInfo ?? null;

  const claudeAccount = accountResponse?.claude?.account ?? null;
  const claudeConnected = Boolean(claudeAccount);
  // A choice this browser made wins while that connection still exists;
  // otherwise the connected subscription.
  const chosen = browserKeys.active;
  const activeProvider: string =
    chosen && isBrowserKeyProvider(chosen)
      ? chosen
      : chosen === "claude_code" && claudeConnected
        ? "claude_code"
        : codexConnected
          ? "codex"
          : claudeConnected
            ? "claude_code"
            : "none";
  const keyItem = (provider: BrowserKeyProvider) => ({
    connected: Boolean(browserKeys.keys[provider]),
    isActive: activeProvider === provider,
    maskedKey: browserKeys.keys[provider]
      ? maskApiKey(browserKeys.keys[provider]!)
      : null,
  });

  const providers: ProviderItem[] = [
    {
      id: "codex",
      displayName: "ChatGPT 구독 (Codex)",
      type: "subscription",
      connected: codexConnected,
      isActive: activeProvider === "codex",
      account: codexAccount,
      rateLimitInfo,
    },
    {
      id: "claude_code",
      displayName: "Claude 구독 (Claude Code)",
      type: "subscription",
      connected: claudeConnected,
      isActive: activeProvider === "claude_code",
      account: claudeAccount,
    },
    {
      id: "gemini_api",
      displayName: "Google Gemini API 키",
      type: "api_key",
      ...keyItem("gemini_api"),
    },
    {
      id: "openai_api",
      displayName: "OpenAI API 키",
      type: "api_key",
      ...keyItem("openai_api"),
    },
    {
      id: "anthropic_api",
      displayName: "Anthropic API 키",
      type: "api_key",
      ...keyItem("anthropic_api"),
    },
    {
      id: "openrouter_api",
      displayName: "OpenRouter API 키",
      type: "api_key",
      ...keyItem("openrouter_api"),
    },
  ];

  const hasAnyConnection = providers.some((p) => p.connected);
  const connectionName = connectedAiName(
    providers,
    accountResponse?.runtime?.displayName,
  );

  return {
    account: codexAccount,
    connectedAt: codexAccount ? (accountResponse?.connectedAt ?? null) : null,
    codeCopied,
    connect,
    connecting,
    copyCode,
    deviceLogin,
    disconnect,
    load,
    localRequest,
    message,
    mode: connectorOrigin ? ("local" as const) : ("internal" as const),
    runtime: accountResponse?.runtime ?? null,
    status,
    // Multi-provider & rate limits
    connectionName,
    providers,
    activeProvider,
    rateLimitInfo,
    hasAnyConnection,
    configureApiKey,
    deleteApiKey,
    selectProvider,
    browserKey,
    withBrowserModels,
    claudeSignIn,
    claudeMessage,
    claudeCompleting,
    connectClaude,
    completeClaude,
    pasteClaudeCode,
    reopenClaudeSignIn,
    disconnectClaude,
    openChatGptSignIn,
  };
}
