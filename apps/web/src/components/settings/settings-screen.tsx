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

export function SettingsScreen({
  email,
  aiConnector,
}: {
  email: string;
  aiConnector: AiConnectorConfig;
}) {
  const ai = useAiAccount(aiConnector);

  const [geminiKeyInput, setGeminiKeyInput] = useState("");
  const [geminiSaving, setGeminiSaving] = useState(false);
  const [geminiError, setGeminiError] = useState("");

  const [openAiKeyInput, setOpenAiKeyInput] = useState("");
  const [openAiSaving, setOpenAiSaving] = useState(false);
  const [openAiError, setOpenAiError] = useState("");

  const [anthropicKeyInput, setAnthropicKeyInput] = useState("");
  const [anthropicSaving, setAnthropicSaving] = useState(false);
  const [anthropicError, setAnthropicError] = useState("");

  const [openRouterKeyInput, setOpenRouterKeyInput] = useState("");
  const [openRouterSaving, setOpenRouterSaving] = useState(false);
  const [openRouterError, setOpenRouterError] = useState("");

  const [successNotice, setSuccessNotice] = useState<string | null>(null);

  const codexProvider = ai.providers.find((p) => p.id === "codex");
  const geminiProvider = ai.providers.find((p) => p.id === "gemini_api");
  const openAiProvider = ai.providers.find((p) => p.id === "openai_api");
  const anthropicProvider = ai.providers.find((p) => p.id === "anthropic_api");
  const openRouterProvider = ai.providers.find((p) => p.id === "openrouter_api");

  const isCodexRateLimited = Boolean(
    codexProvider?.rateLimitInfo?.isRateLimited,
  );
  const codexResetTime = formatReset(codexProvider?.rateLimitInfo?.resetAt);

  const notify = (msg: string) => {
    setSuccessNotice(msg);
    window.setTimeout(() => setSuccessNotice(null), 5000);
  };

  const handleSaveGemini = async () => {
    const val = geminiKeyInput.trim();
    if (!val) {
      setGeminiError("Google Gemini API 키를 입력해 주세요. (AIzaSy로 시작하는 키)");
      return;
    }
    setGeminiSaving(true);
    setGeminiError("");
    try {
      await ai.configureApiKey("gemini_api", val, true);
      setGeminiKeyInput("");
      notify("Google Gemini 2.5가 성공적으로 연결 및 활성화되었습니다!");
    } catch (e: any) {
      setGeminiError(e.message || "Google Gemini API 키를 검증하지 못했습니다.");
    } finally {
      setGeminiSaving(false);
    }
  };

  const handleSaveOpenAi = async () => {
    const val = openAiKeyInput.trim();
    if (!val) {
      setOpenAiError("OpenAI API 키를 입력해 주세요. (sk-로 시작하는 키)");
      return;
    }
    setOpenAiSaving(true);
    setOpenAiError("");
    try {
      await ai.configureApiKey("openai_api", val, true);
      setOpenAiKeyInput("");
      notify("OpenAI API가 성공적으로 연결 및 활성화되었습니다!");
    } catch (e: any) {
      setOpenAiError(e.message || "OpenAI API 키를 검증하지 못했습니다.");
    } finally {
      setOpenAiSaving(false);
    }
  };

  const handleSaveAnthropic = async () => {
    const val = anthropicKeyInput.trim();
    if (!val) {
      setAnthropicError("Anthropic API 키를 입력해 주세요. (sk-ant-로 시작하는 키)");
      return;
    }
    setAnthropicSaving(true);
    setAnthropicError("");
    try {
      await ai.configureApiKey("anthropic_api", val, true);
      setAnthropicKeyInput("");
      notify("Anthropic Claude API가 성공적으로 연결 및 활성화되었습니다!");
    } catch (e: any) {
      setAnthropicError(e.message || "Anthropic API 키를 검증하지 못했습니다.");
    } finally {
      setAnthropicSaving(false);
    }
  };

  const handleSaveOpenRouter = async () => {
    const val = openRouterKeyInput.trim();
    if (!val) {
      setOpenRouterError("OpenRouter API 키를 입력해 주세요.");
      return;
    }
    setOpenRouterSaving(true);
    setOpenRouterError("");
    try {
      await ai.configureApiKey("openrouter_api", val, true);
      setOpenRouterKeyInput("");
      notify("OpenRouter가 성공적으로 연결 및 활성화되었습니다!");
    } catch (e: any) {
      setOpenRouterError(e.message || "OpenRouter API 키를 검증하지 못했습니다.");
    } finally {
      setOpenRouterSaving(false);
    }
  };

  const activeName =
    ai.activeProvider === "gemini_api"
      ? "Google Gemini (Gemini 2.5 Flash / Pro)"
      : ai.activeProvider === "openai_api"
        ? "OpenAI API (GPT-4o / o3-mini)"
        : ai.activeProvider === "anthropic_api"
          ? "Anthropic API (Claude 3.7 Sonnet)"
          : ai.activeProvider === "openrouter_api"
            ? "OpenRouter (DeepSeek / Llama)"
            : ai.activeProvider === "codex" && codexProvider?.connected
              ? `ChatGPT 구독 · Codex (${codexProvider.account?.email ?? "연결됨"})`
              : "없음 (미연결)";

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
                  Google Gemini, OpenAI, Anthropic, OpenRouter 또는 ChatGPT
                  구독을 등록하고, 언제든지 원하는 AI로 즉시 전환할 수 있습니다.
                </p>
              </header>

              {/* ── Active Status Hero Banner ── */}
              <div style={{ marginBottom: "1.25rem" }}>
                {ai.activeProvider !== "none" ? (
                  <Banner tone="ok" role="status">
                    <strong>현재 사용 중인 AI:</strong> {activeName}
                    <br />
                    프레젠테이션 편집 시 이 AI가 요청을 처리합니다. 아래 목록에서
                    원하는 AI의 <strong>[이 AI 사용하기]</strong> 버튼을 누르면 1초
                    만에 전환됩니다.
                  </Banner>
                ) : (
                  <Banner tone="warn" role="status">
                    ⚠️ <strong>현재 연결된 AI가 없습니다.</strong> 아래에서
                    <strong> Google Gemini API 키</strong> 또는
                    본인의 API 키/구독을 등록해 주세요.
                  </Banner>
                )}
              </div>

              {successNotice ? (
                <div style={{ marginBottom: "1.25rem" }}>
                  <Banner tone="ok" role="status">
                    ✓ {successNotice}
                  </Banner>
                </div>
              ) : null}

              {/* ── 1. Google Gemini (Google AI Studio) ── */}
              <div className="conn-card" style={{ marginBottom: "1rem" }}>
                <span className="conn-mark" aria-hidden="true">
                  <Icon name="sparkles" size={18} />
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                    <strong>Google Gemini (Google AI Studio)</strong>
                    <Badge tone="ok">추천</Badge>
                  </div>
                  <small style={{ display: "block", marginTop: "0.25rem" }}>
                    {geminiProvider?.connected
                      ? `등록된 API 키: ${geminiProvider.maskedKey} · Gemini 2.5 Flash / 2.5 Pro 사용 가능`
                      : "Google AI Studio에서 발급받은 API 키로 초고속 멀티모달 Gemini 2.5를 사용해요."}
                  </small>
                  <div style={{ marginTop: "0.25rem" }}>
                    <ButtonLink
                      size="sm"
                      variant="quiet"
                      icon="external"
                      href="https://aistudio.google.com/apikey"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Google AI Studio API 키 관리 ↗
                    </ButtonLink>
                  </div>

                  <div
                    style={{
                      marginTop: "0.75rem",
                      display: "flex",
                      gap: "0.5rem",
                      flexWrap: "wrap",
                    }}
                  >
                    <input
                      type="password"
                      placeholder={
                        geminiProvider?.connected
                          ? "새 API 키 입력 (변경 시)"
                          : "AIzaSy로 시작하는 키를 입력해 주세요"
                      }
                      value={geminiKeyInput}
                      onChange={(e) => {
                        setGeminiKeyInput(e.target.value);
                        if (geminiError) setGeminiError("");
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleSaveGemini();
                      }}
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
                      loading={geminiSaving}
                      onClick={() => void handleSaveGemini()}
                    >
                      {geminiProvider?.connected ? "키 변경" : "키 등록 및 활성화"}
                    </Button>
                  </div>
                  {geminiError ? (
                    <p
                      style={{
                        color: "var(--danger)",
                        fontSize: "12px",
                        marginTop: "0.375rem",
                        fontWeight: 500,
                      }}
                    >
                      {geminiError}
                    </p>
                  ) : null}
                </div>
                {geminiProvider?.connected ? (
                  <div className="conn-card-actions">
                    {geminiProvider.isActive ? (
                      <Badge tone="ok" dot>
                        현재 사용 중
                      </Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={async () => {
                          await ai.selectProvider("gemini_api");
                          notify("Google Gemini로 전환되었습니다!");
                        }}
                      >
                        이 AI 사용하기
                      </Button>
                    )}
                    <Button
                      variant="danger-quiet"
                      size="sm"
                      onClick={async () => {
                        await ai.deleteApiKey("gemini_api");
                        notify("Google Gemini API 키가 삭제되었습니다.");
                      }}
                    >
                      삭제
                    </Button>
                  </div>
                ) : null}
              </div>

              {/* ── 2. OpenAI API Key (BYOK) ── */}
              <div className="conn-card" style={{ marginBottom: "1rem" }}>
                <span className="conn-mark" aria-hidden="true">
                  <Icon name="sparkles" size={18} />
                </span>
                <div style={{ flex: 1 }}>
                  <strong>OpenAI API 키 (직접 발급받은 키)</strong>
                  <small style={{ display: "block", marginTop: "0.25rem" }}>
                    {openAiProvider?.connected
                      ? `등록된 API 키: ${openAiProvider.maskedKey} · GPT-4o, o3-mini 등 종량제 사용`
                      : "OpenAI 대시보드에서 발급받은 본인의 API 키(sk-...)를 종량제로 사용해요."}
                  </small>
                  <div style={{ marginTop: "0.25rem" }}>
                    <ButtonLink
                      size="sm"
                      variant="quiet"
                      icon="external"
                      href="https://platform.openai.com/api-keys"
                      target="_blank"
                      rel="noreferrer"
                    >
                      OpenAI 플랫폼에서 키 발급받기 ↗
                    </ButtonLink>
                  </div>
                  <div
                    style={{
                      marginTop: "0.75rem",
                      display: "flex",
                      gap: "0.5rem",
                      flexWrap: "wrap",
                    }}
                  >
                    <input
                      type="password"
                      placeholder={
                        openAiProvider?.connected
                          ? "새 API 키 입력 (변경 시)"
                          : "sk-로 시작하는 키를 입력해 주세요"
                      }
                      value={openAiKeyInput}
                      onChange={(e) => {
                        setOpenAiKeyInput(e.target.value);
                        if (openAiError) setOpenAiError("");
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleSaveOpenAi();
                      }}
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
                      onClick={() => void handleSaveOpenAi()}
                    >
                      {openAiProvider?.connected ? "키 변경" : "키 등록 및 활성화"}
                    </Button>
                  </div>
                  {openAiError ? (
                    <p
                      style={{
                        color: "var(--danger)",
                        fontSize: "12px",
                        marginTop: "0.375rem",
                        fontWeight: 500,
                      }}
                    >
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
                        variant="primary"
                        onClick={async () => {
                          await ai.selectProvider("openai_api");
                          notify("OpenAI API로 전환되었습니다!");
                        }}
                      >
                        이 AI 사용하기
                      </Button>
                    )}
                    <Button
                      variant="danger-quiet"
                      size="sm"
                      onClick={async () => {
                        await ai.deleteApiKey("openai_api");
                        notify("OpenAI API 키가 삭제되었습니다.");
                      }}
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
                  <small style={{ display: "block", marginTop: "0.25rem" }}>
                    {anthropicProvider?.connected
                      ? `등록된 API 키: ${anthropicProvider.maskedKey} · Claude 3.7 Sonnet 사용 가능`
                      : "Anthropic 콘솔에서 발급받은 API 키(sk-ant-...)로 Claude 3.7을 사용해요."}
                  </small>
                  <div style={{ marginTop: "0.25rem" }}>
                    <ButtonLink
                      size="sm"
                      variant="quiet"
                      icon="external"
                      href="https://console.anthropic.com/settings/keys"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Anthropic 콘솔에서 키 발급받기 ↗
                    </ButtonLink>
                  </div>
                  <div
                    style={{
                      marginTop: "0.75rem",
                      display: "flex",
                      gap: "0.5rem",
                      flexWrap: "wrap",
                    }}
                  >
                    <input
                      type="password"
                      placeholder={
                        anthropicProvider?.connected
                          ? "새 API 키 입력 (변경 시)"
                          : "sk-ant-로 시작하는 키를 입력해 주세요"
                      }
                      value={anthropicKeyInput}
                      onChange={(e) => {
                        setAnthropicKeyInput(e.target.value);
                        if (anthropicError) setAnthropicError("");
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleSaveAnthropic();
                      }}
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
                      onClick={() => void handleSaveAnthropic()}
                    >
                      {anthropicProvider?.connected ? "키 변경" : "키 등록 및 활성화"}
                    </Button>
                  </div>
                  {anthropicError ? (
                    <p
                      style={{
                        color: "var(--danger)",
                        fontSize: "12px",
                        marginTop: "0.375rem",
                        fontWeight: 500,
                      }}
                    >
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
                        variant="primary"
                        onClick={async () => {
                          await ai.selectProvider("anthropic_api");
                          notify("Anthropic Claude API로 전환되었습니다!");
                        }}
                      >
                        이 AI 사용하기
                      </Button>
                    )}
                    <Button
                      variant="danger-quiet"
                      size="sm"
                      onClick={async () => {
                        await ai.deleteApiKey("anthropic_api");
                        notify("Anthropic API 키가 삭제되었습니다.");
                      }}
                    >
                      삭제
                    </Button>
                  </div>
                ) : null}
              </div>

              {/* ── 4. OpenRouter API Key (BYOK) ── */}
              <div className="conn-card" style={{ marginBottom: "1rem" }}>
                <span className="conn-mark" aria-hidden="true">
                  <Icon name="sparkles" size={18} />
                </span>
                <div style={{ flex: 1 }}>
                  <strong>OpenRouter API 키 (DeepSeek, Llama 등 통합)</strong>
                  <small style={{ display: "block", marginTop: "0.25rem" }}>
                    {openRouterProvider?.connected
                      ? `등록된 API 키: ${openRouterProvider.maskedKey} · DeepSeek V3/R1 등 사용`
                      : "OpenRouter 키 하나로 DeepSeek R1, V3, Llama 3.3 등 다양한 모델을 사용해요."}
                  </small>
                  <div style={{ marginTop: "0.25rem" }}>
                    <ButtonLink
                      size="sm"
                      variant="quiet"
                      icon="external"
                      href="https://openrouter.ai/keys"
                      target="_blank"
                      rel="noreferrer"
                    >
                      OpenRouter에서 키 발급받기 ↗
                    </ButtonLink>
                  </div>
                  <div
                    style={{
                      marginTop: "0.75rem",
                      display: "flex",
                      gap: "0.5rem",
                      flexWrap: "wrap",
                    }}
                  >
                    <input
                      type="password"
                      placeholder={
                        openRouterProvider?.connected
                          ? "새 API 키 입력 (변경 시)"
                          : "sk-or-v1-로 시작하는 키를 입력해 주세요"
                      }
                      value={openRouterKeyInput}
                      onChange={(e) => {
                        setOpenRouterKeyInput(e.target.value);
                        if (openRouterError) setOpenRouterError("");
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleSaveOpenRouter();
                      }}
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
                      loading={openRouterSaving}
                      onClick={() => void handleSaveOpenRouter()}
                    >
                      {openRouterProvider?.connected ? "키 변경" : "키 등록 및 활성화"}
                    </Button>
                  </div>
                  {openRouterError ? (
                    <p
                      style={{
                        color: "var(--danger)",
                        fontSize: "12px",
                        marginTop: "0.375rem",
                        fontWeight: 500,
                      }}
                    >
                      {openRouterError}
                    </p>
                  ) : null}
                </div>
                {openRouterProvider?.connected ? (
                  <div className="conn-card-actions">
                    {openRouterProvider.isActive ? (
                      <Badge tone="ok" dot>
                        현재 사용 중
                      </Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={async () => {
                          await ai.selectProvider("openrouter_api");
                          notify("OpenRouter로 전환되었습니다!");
                        }}
                      >
                        이 AI 사용하기
                      </Button>
                    )}
                    <Button
                      variant="danger-quiet"
                      size="sm"
                      onClick={async () => {
                        await ai.deleteApiKey("openrouter_api");
                        notify("OpenRouter API 키가 삭제되었습니다.");
                      }}
                    >
                      삭제
                    </Button>
                  </div>
                ) : null}
              </div>

              {/* ── 5. ChatGPT Subscription (Codex) ── */}
              <div
                className={`conn-card ${codexProvider?.connected ? "" : "is-expanded"}`}
                style={{ marginBottom: "1rem" }}
              >
                <span className="conn-mark" aria-hidden="true">
                  <Icon name="sparkles" size={18} />
                </span>
                <div style={{ flex: 1 }}>
                  <strong>ChatGPT 구독 · Codex</strong>
                  <small style={{ display: "block", marginTop: "0.25rem" }}>
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
                      : "내 ChatGPT (Plus/Pro/Team) 구독 계정을 장치 코드로 연동해요."}
                  </small>

                  {isCodexRateLimited ? (
                    <div style={{ marginTop: "0.5rem" }}>
                      <Banner tone="warn" role="status">
                        ⚠️ <strong>OpenAI Codex 사용량 한도 도달</strong>: 이번
                        주기 메시지 한도를 모두 소모했습니다.
                        {codexResetTime ? ` (${codexResetTime} 리셋 예정)` : ""}
                        <br />
                        위의 <strong>Google Gemini</strong>나 <strong>API 키</strong>를 등록하여 즉시 작업을 이어갈 수 있습니다.
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
                        variant="primary"
                        onClick={async () => {
                          await ai.selectProvider("codex");
                          notify("ChatGPT Codex로 전환되었습니다!");
                        }}
                      >
                        이 AI 사용하기
                      </Button>
                    )}
                    <Button
                      variant="danger-quiet"
                      size="sm"
                      onClick={async () => {
                        await ai.disconnect();
                        notify("ChatGPT 구독 연결이 해제되었습니다.");
                      }}
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
