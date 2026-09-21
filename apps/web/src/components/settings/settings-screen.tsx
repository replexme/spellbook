"use client";

import { useState } from "react";
import { Badge, Banner, Button, ButtonLink, Icon, Spinner } from "@/design-system";
import type { AiConnectorConfig } from "@/lib/ai-connector-config";
import { useAiAccount } from "@/lib/use-ai-account";
import { AppTop } from "../app-top";
import { ConnectSteps } from "../workspace/connect-steps";

const connectedDay = new Intl.DateTimeFormat("ko-KR", {
  month: "long",
  day: "numeric",
});

const resetDayTime = new Intl.DateTimeFormat("ko-KR", {
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
});

function planLabel(plan: string | null | undefined) {
  if (!plan) return null;
  return `${plan.charAt(0).toUpperCase()}${plan.slice(1)} 플랜`;
}

function formatReset(resetAt: number | null | undefined) {
  if (!resetAt) return null;
  try {
    return resetDayTime.format(new Date(resetAt * 1000));
  } catch {
    return null;
  }
}

/** AI connections & providers management; easily switch between subscriptions and custom API keys. */
export function SettingsScreen({
  email,
  aiConnector,
}: {
  email: string;
  aiConnector: AiConnectorConfig;
}) {
  const ai = useAiAccount(aiConnector);
  const local = ai.mode === "local";
  const [openAiKeyInput, setOpenAiKeyInput] = useState("");
  const [openAiSaving, setOpenAiSaving] = useState(false);
  const [openAiError, setOpenAiError] = useState("");

  const [anthropicKeyInput, setAnthropicKeyInput] = useState("");
  const [anthropicSaving, setAnthropicSaving] = useState(false);
  const [anthropicError, setAnthropicError] = useState("");

  const codexProvider = ai.providers.find((p) => p.id === "codex");
  const openAiProvider = ai.providers.find((p) => p.id === "openai_api");
  const anthropicProvider = ai.providers.find((p) => p.id === "anthropic_api");
  const claudeProvider = ai.providers.find((p) => p.id === "claude_code");

  const isCodexRateLimited = Boolean(
    codexProvider?.rateLimitInfo?.isRateLimited,
  );
  const codexResetTime = formatReset(codexProvider?.rateLimitInfo?.resetAt);

  const saveOpenAiKey = async () => {
    if (!openAiKeyInput.trim()) return;
    setOpenAiSaving(true);
    setOpenAiError("");
    try {
      await ai.configureApiKey("openai_api", openAiKeyInput);
      setOpenAiKeyInput("");
    } catch (e: any) {
      setOpenAiError(e.message || "OpenAI API 키를 검증하지 못했습니다.");
    } finally {
      setOpenAiSaving(false);
    }
  };

  const saveAnthropicKey = async () => {
    if (!anthropicKeyInput.trim()) return;
    setAnthropicSaving(true);
    setAnthropicError("");
    try {
      await ai.configureApiKey("anthropic_api", anthropicKeyInput);
      setAnthropicKeyInput("");
    } catch (e: any) {
      setAnthropicError(e.message || "Anthropic API 키를 검증하지 못했습니다.");
    } finally {
      setAnthropicSaving(false);
    }
  };

  return (
    <>
      <AppTop email={email} ai={ai} />
      <main className="app-main">
        <div className="settings">
          <nav className="settings-nav" aria-label="설정">
            <a href="#ai">AI 연결 및 공급자</a>
            <a href="#account">계정</a>
          </nav>
          <div className="settings-body">
            <section
              id="ai"
              className="settings-section"
              aria-labelledby="settings-ai"
            >
              <header>
                <h1 id="settings-ai">AI 연결 및 공급자</h1>
                <p>
                  ChatGPT / Claude 구독 또는 본인의 API 키를 등록하고 언제든지
                  원하는 AI로 전환하여 사용할 수 있습니다.
                </p>
              </header>

              {/* ── 1. ChatGPT Subscription (Codex) ── */}
              <div
                className={`conn-card ${codexProvider?.connected ? "" : "is-expanded"}`}
                style={{ marginBottom: "1rem" }}
              >
                <span className="conn-mark" aria-hidden="true">
                  <Icon name="sparkles" size={18} />
                </span>
                <div style={{ flex: 1 }}>
                  <strong>ChatGPT 구독 · Codex</strong>
                  <small>
                    {codexProvider?.connected
                      ? [
                          codexProvider.account?.email ?? "ChatGPT 계정",
                          planLabel(codexProvider.account?.planType),
                          ai.connectedAt
                            ? `${connectedDay.format(new Date(ai.connectedAt))} 연결`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")
                      : "내 ChatGPT (Plus/Pro/Team) 구독으로 Codex를 써요"}
                  </small>

                  {isCodexRateLimited ? (
                    <div style={{ marginTop: "0.5rem" }}>
                      <Banner tone="warn" role="status">
                        ⚠️ <strong>OpenAI Codex 사용량 한도 도달</strong>: 이번
                        주기 메시지 한도를 모두 소모했습니다.
                        {codexResetTime ? ` (${codexResetTime} 리셋 예정)` : ""}
                        <br />
                        크레딧 충전 또는 아래의 <strong>OpenAI / Anthropic API 키</strong>를 등록하여 즉시 작업을 이어갈 수 있습니다.
                      </Banner>
                    </div>
                  ) : null}
                </div>
                {codexProvider?.connected ? (
                  <div className="conn-card-actions">
                    {codexProvider.isActive ? (
                      <Badge tone="ok" dot>
                        현재 사용 중
                      </Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void ai.selectProvider("codex")}
                      >
                        이 공급자로 전환
                      </Button>
                    )}
                    <Button
                      variant="danger-quiet"
                      size="sm"
                      onClick={() => void ai.disconnect()}
                    >
                      연결 해제
                    </Button>
                  </div>
                ) : (
                  <div className="conn-card-body">
                    <ConnectSteps ai={ai} />
                  </div>
                )}
              </div>

              {/* ── 2. OpenAI API Key (BYOK) ── */}
              <div className="conn-card" style={{ marginBottom: "1rem" }}>
                <span className="conn-mark" aria-hidden="true">
                  <Icon name="sparkles" size={18} />
                </span>
                <div style={{ flex: 1 }}>
                  <strong>OpenAI API 키 (직접 발급받은 키)</strong>
                  <small>
                    {openAiProvider?.connected
                      ? `등록된 API 키: ${openAiProvider.maskedKey} (GPT-4o, o3-mini 등)`
                      : "본인의 OpenAI API 키(sk-...)를 등록하여 종량제로 사용해요"}
                  </small>
                  <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    <input
                      type="password"
                      placeholder={
                        openAiProvider?.connected
                          ? "새 API 키 입력 (변경 시)"
                          : "sk-..."
                      }
                      value={openAiKeyInput}
                      onChange={(e) => setOpenAiKeyInput(e.target.value)}
                      style={{
                        padding: "0.375rem 0.75rem",
                        borderRadius: "6px",
                        border: "1px solid var(--border)",
                        fontFamily: "monospace",
                        fontSize: "13px",
                        width: "320px",
                        maxWidth: "100%",
                      }}
                    />
                    <Button
                      size="sm"
                      variant="primary"
                      loading={openAiSaving}
                      onClick={() => void saveOpenAiKey()}
                    >
                      {openAiProvider?.connected ? "키 변경" : "키 등록 및 검증"}
                    </Button>
                  </div>
                  {openAiError ? (
                    <p style={{ color: "var(--danger)", fontSize: "12px", marginTop: "0.375rem" }}>
                      {openAiError}
                    </p>
                  ) : null}
                </div>
                {openAiProvider?.connected ? (
                  <div className="conn-card-actions">
                    {openAiProvider.isActive ? (
                      <Badge tone="ok" dot>
                        현재 사용 중
                      </Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void ai.selectProvider("openai_api")}
                      >
                        이 공급자로 전환
                      </Button>
                    )}
                    <Button
                      variant="danger-quiet"
                      size="sm"
                      onClick={() => void ai.deleteApiKey("openai_api")}
                    >
                      삭제
                    </Button>
                  </div>
                ) : null}
              </div>

              {/* ── 3. Anthropic API Key (BYOK) ── */}
              <div className="conn-card" style={{ marginBottom: "1rem" }}>
                <span className="conn-mark" aria-hidden="true">
                  <Icon name="sparkles" size={18} />
                </span>
                <div style={{ flex: 1 }}>
                  <strong>Anthropic API 키 (Claude 직접 사용)</strong>
                  <small>
                    {anthropicProvider?.connected
                      ? `등록된 API 키: ${anthropicProvider.maskedKey} (Claude 3.7 Sonnet 등)`
                      : "본인의 Anthropic API 키(sk-ant-...)를 등록하여 Claude 모델을 사용해요"}
                  </small>
                  <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    <input
                      type="password"
                      placeholder={
                        anthropicProvider?.connected
                          ? "새 API 키 입력 (변경 시)"
                          : "sk-ant-..."
                      }
                      value={anthropicKeyInput}
                      onChange={(e) => setAnthropicKeyInput(e.target.value)}
                      style={{
                        padding: "0.375rem 0.75rem",
                        borderRadius: "6px",
                        border: "1px solid var(--border)",
                        fontFamily: "monospace",
                        fontSize: "13px",
                        width: "320px",
                        maxWidth: "100%",
                      }}
                    />
                    <Button
                      size="sm"
                      variant="primary"
                      loading={anthropicSaving}
                      onClick={() => void saveAnthropicKey()}
                    >
                      {anthropicProvider?.connected ? "키 변경" : "키 등록 및 검증"}
                    </Button>
                  </div>
                  {anthropicError ? (
                    <p style={{ color: "var(--danger)", fontSize: "12px", marginTop: "0.375rem" }}>
                      {anthropicError}
                    </p>
                  ) : null}
                </div>
                {anthropicProvider?.connected ? (
                  <div className="conn-card-actions">
                    {anthropicProvider.isActive ? (
                      <Badge tone="ok" dot>
                        현재 사용 중
                      </Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void ai.selectProvider("anthropic_api")}
                      >
                        이 공급자로 전환
                      </Button>
                    )}
                    <Button
                      variant="danger-quiet"
                      size="sm"
                      onClick={() => void ai.deleteApiKey("anthropic_api")}
                    >
                      삭제
                    </Button>
                  </div>
                ) : null}
              </div>

              {/* ── 4. Claude Code Subscription ── */}
              <div className="conn-card">
                <span className="conn-mark" aria-hidden="true">
                  <Icon name="home" size={18} />
                </span>
                <div style={{ flex: 1 }}>
                  <strong>Claude 구독 · Claude Code</strong>
                  <small>
                    컴퓨터의 Claude CLI 로그인 세션을 로컬 연결 앱으로 직접
                    사용해요
                  </small>
                </div>
                <div className="conn-card-actions">
                  <ButtonLink
                    size="sm"
                    variant="quiet"
                    icon="external"
                    href="https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview"
                    target="_blank"
                    rel="noreferrer"
                  >
                    안내 보기
                  </ButtonLink>
                </div>
              </div>
            </section>

            <section
              id="account"
              className="settings-section"
              aria-labelledby="settings-account"
            >
              <header>
                <h1 id="settings-account">계정</h1>
                <p>
                  이 서버에 로그인한 계정이에요. 파일과 작업 기록은 계정마다
                  따로 보관해요.
                </p>
              </header>
              <div className="conn-card">
                <span className="conn-mark" aria-hidden="true">
                  <Icon name="lock" size={18} />
                </span>
                <div>
                  <strong>{email}</strong>
                  <small>로그인됨</small>
                </div>
                <div className="conn-card-actions">
                  <ButtonLink size="sm" icon="logout" href="/auth/logout">
                    로그아웃
                  </ButtonLink>
                </div>
              </div>
            </section>
          </div>
        </div>
      </main>
    </>
  );
}
