"use client";

import { Badge, Button, ButtonLink, Icon } from "@/design-system";
import type { AiConnectorConfig } from "@/lib/ai-connector-config";
import { useAiAccount } from "@/lib/use-ai-account";
import { AppTop } from "../app-top";
import { ConnectSteps } from "../workspace/connect-steps";

const connectedDay = new Intl.DateTimeFormat("ko-KR", {
  month: "long",
  day: "numeric",
});

function planLabel(plan: string | null | undefined) {
  if (!plan) return null;
  return `${plan.charAt(0).toUpperCase()}${plan.slice(1)} 플랜`;
}

/** AI connection lives here; the workspace panel shows the same steps when needed. */
export function SettingsScreen({
  email,
  aiConnector,
}: {
  email: string;
  aiConnector: AiConnectorConfig;
}) {
  const ai = useAiAccount(aiConnector);
  const local = ai.mode === "local";
  const account = ai.account;
  const name = local
    ? `이 컴퓨터의 연결 앱${ai.runtime ? ` · ${ai.runtime.displayName}` : ""}`
    : "ChatGPT · Codex";
  const detail = account
    ? [
        account.email ??
          (account.type === "claude" ? "Claude 계정" : "ChatGPT 계정"),
        planLabel(account.planType),
        ai.connectedAt
          ? `${connectedDay.format(new Date(ai.connectedAt))} 연결`
          : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : local
      ? "Codex나 Claude Code 구독을 이 컴퓨터에서 써요"
      : "내 ChatGPT 구독으로 Codex를 써요";
  return (
    <>
      <AppTop email={email} ai={ai} />
      <main className="app-main">
        <div className="settings">
          <nav className="settings-nav" aria-label="설정">
            <a href="#ai">AI 연결</a>
            <a href="#account">계정</a>
          </nav>
          <div className="settings-body">
            <section
              id="ai"
              className="settings-section"
              aria-labelledby="settings-ai"
            >
              <header>
                <h1 id="settings-ai">AI 연결</h1>
                <p>
                  {local
                    ? "AI에게 요청할 때 내 구독을 써요. 구독 로그인과 문서 도구는 이 컴퓨터의 연결 앱에서 실행되고, 비밀번호와 구독 토큰은 서버로 가지 않아요."
                    : "AI에게 요청할 때 내 구독을 써요. 로그인은 OpenAI 화면에서 하고, 이 서비스는 비밀번호를 받지 않아요."}
                </p>
              </header>
              <div className={`conn-card ${account ? "" : "is-expanded"}`}>
                <span className="conn-mark" aria-hidden="true">
                  <Icon name={local ? "home" : "sparkles"} size={18} />
                </span>
                <div>
                  <strong>{name}</strong>
                  <small>{detail}</small>
                </div>
                {account ? (
                  <div className="conn-card-actions">
                    <Badge tone="ok" dot>
                      연결됨
                    </Badge>
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
