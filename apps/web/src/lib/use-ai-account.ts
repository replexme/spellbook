"use client";

import { useCallback, useEffect, useState } from "react";
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
  /** The Claude subscription connected on the server, if any. */
  claude?: { account?: AiAccount | null } | null;
};

export interface ClaudeSignIn {
  verificationUrl: string;
  loginReference: string;
}

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
  const [keyScope, setKeyScope] = useState<string | null>(null);
  const [claudeSignIn, setClaudeSignIn] = useState<ClaudeSignIn | null>(null);
  const [claudeMessage, setClaudeMessage] = useState("");
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
    if (!deviceLogin && !waitingForBrowserLogin) return;
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [deviceLogin, waitingForBrowserLogin, load]);

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
      const response = await fetch("/api/ai/account/login", { method: "POST" });
      if (response.status === 401) {
        bounceToLogin();
        return;
      }
      const value = (await response.json()) as AiDeviceLogin & {
        error?: string;
      };
      if (!response.ok) {
        setMessage(
          "OpenAI 보안 설정에서 ‘Codex용 장치 코드 인증’을 켠 뒤 다시 시도해 주세요.",
        );
        return;
      }
      setDeviceLogin(value);
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
  }, [connectorOrigin, load]);

  const copyCode = useCallback(async () => {
    if (!deviceLogin) return;
    await navigator.clipboard.writeText(deviceLogin.userCode);
    setCodeCopied(true);
  }, [deviceLogin]);

  const disconnect = useCallback(async () => {
    if (connectorOrigin && localSession) {
      try {
        await callLocalConnector(
          connectorOrigin,
          "/v1/account/logout",
          localSession,
        );
      } finally {
        window.sessionStorage.removeItem(LOCAL_CONNECTOR_SESSION_KEY);
        setLocalSession(null);
        setWaitingForBrowserLogin(false);
      }
    } else await fetch("/api/ai/account/logout", { method: "POST" });
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

  // Claude's sign-in page shows a code that the person pastes back here.
  const connectClaude = useCallback(async () => {
    setClaudeMessage("");
    const response = await fetch("/api/ai/account/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "claude_code" }),
    });
    if (response.status === 401) {
      bounceToLogin();
      return;
    }
    const value = (await response.json()) as Partial<ClaudeSignIn> & {
      error?: string;
    };
    if (!response.ok || !value.verificationUrl || !value.loginReference) {
      setClaudeMessage(
        "Claude 로그인을 시작하지 못했어요. 다시 시도해 주세요.",
      );
      return;
    }
    setClaudeSignIn({
      verificationUrl: value.verificationUrl,
      loginReference: value.loginReference,
    });
  }, []);

  const completeClaude = useCallback(
    async (code: string) => {
      if (!claudeSignIn) return;
      setClaudeMessage("");
      const response = await fetch("/api/ai/account/login/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: code.trim(),
          loginReference: claudeSignIn.loginReference,
        }),
      });
      if (!response.ok) {
        setClaudeMessage(
          "코드를 확인하지 못했어요. Claude 로그인을 다시 시작해 주세요.",
        );
        setClaudeSignIn(null);
        return;
      }
      setClaudeSignIn(null);
      await load();
    },
    [claudeSignIn, load],
  );

  const disconnectClaude = useCallback(async () => {
    await fetch("/api/ai/account/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "claude_code" }),
    });
    await load();
  }, [load]);

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
    connectClaude,
    completeClaude,
    disconnectClaude,
  };
}
