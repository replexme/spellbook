"use client";

import { useCallback, useEffect, useState } from "react";
import type { AiConnectorConfig } from "./ai-connector-config";
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

export interface ProviderItem {
  id: "codex" | "claude_code" | "openai_api" | "anthropic_api";
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
  customProviders?: Array<{
    provider: string;
    isActive: boolean;
    maskedKey: string | null;
  }>;
};

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

  const load = useCallback(async () => {
    try {
      if (connectorOrigin) {
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
      if (!response.ok) throw new Error("account_status_unavailable");
      const value = (await response.json()) as AccountResponse;
      setAccountResponse(value);
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

  const configureApiKey = useCallback(
    async (
      provider: "openai_api" | "anthropic_api",
      apiKey: string,
      active = true,
    ) => {
      const res = await fetch("/api/ai/provider/configure", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, apiKey, active }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "API 키를 저장하지 못했습니다.");
      }
      await load();
    },
    [load],
  );

  const deleteApiKey = useCallback(
    async (provider: string) => {
      const res = await fetch("/api/ai/provider/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "API 키를 삭제하지 못했습니다.");
      }
      await load();
    },
    [load],
  );

  const selectProvider = useCallback(
    async (provider: string) => {
      const res = await fetch("/api/ai/provider/select", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "공급자를 변경하지 못했습니다.");
      }
      await load();
    },
    [load],
  );

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

  const customProviders = accountResponse?.customProviders ?? [];
  const openAiCustom = customProviders.find((p) => p.provider === "openai_api");
  const anthropicCustom = customProviders.find(
    (p) => p.provider === "anthropic_api",
  );

  const activeProvider =
    accountResponse?.activeProvider ??
    (openAiCustom?.isActive
      ? "openai_api"
      : anthropicCustom?.isActive
        ? "anthropic_api"
        : codexConnected
          ? "codex"
          : "none");

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
      connected: false,
      isActive: activeProvider === "claude_code",
    },
    {
      id: "openai_api",
      displayName: "OpenAI API 키",
      type: "api_key",
      connected: Boolean(openAiCustom),
      isActive: activeProvider === "openai_api",
      maskedKey: openAiCustom?.maskedKey,
    },
    {
      id: "anthropic_api",
      displayName: "Anthropic API 키",
      type: "api_key",
      connected: Boolean(anthropicCustom),
      isActive: activeProvider === "anthropic_api",
      maskedKey: anthropicCustom?.maskedKey,
    },
  ];

  const hasAnyConnection = providers.some((p) => p.connected);

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
    providers,
    activeProvider,
    rateLimitInfo,
    hasAnyConnection,
    configureApiKey,
    deleteApiKey,
    selectProvider,
  };
}
