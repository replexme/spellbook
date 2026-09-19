"use client";

import { Banner, Button, ButtonLink, Spinner } from "@/design-system";
import { CHATGPT_SECURITY_URL, type useAiAccount } from "@/lib/use-ai-account";

type Ai = ReturnType<typeof useAiAccount>;

function Step({
  number,
  state,
  title,
  children,
}: {
  number: number;
  state: "done" | "now" | "todo";
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <li className={`connect-step is-${state}`}>
      <i aria-hidden="true">{state === "done" ? "✓" : number}</i>
      <div>
        <strong>{title}</strong>
        {children}
      </div>
    </li>
  );
}

/** Numbered connection steps. The panel and the settings page share it. */
export function ConnectSteps({ ai }: { ai: Ai }) {
  if (ai.status === "loading")
    return (
      <p className="connect-status" role="status">
        <Spinner /> AI 연결을 확인하고 있어요.
      </p>
    );
  if (ai.status === "error")
    return (
      <div className="connect">
        <Banner tone="danger" role="alert">
          AI 연결 상태를 확인하지 못했어요. 네트워크를 확인한 뒤 다시 시도해
          주세요.
        </Banner>
        <div>
          <Button icon="refresh" onClick={() => void ai.load()}>
            연결 상태 다시 확인
          </Button>
        </div>
      </div>
    );
  if (ai.mode === "local")
    return (
      <ol className="connect" aria-label="AI 연결 단계">
        <Step
          number={1}
          state="now"
          title="이 컴퓨터에서 Spellbook 연결 앱을 실행해요"
        >
          <p>
            구독 로그인과 문서 도구는 이 컴퓨터의 연결 앱에서 실행돼요.
            비밀번호와 구독 토큰은 서버로 가지 않아요.
          </p>
        </Step>
        <Step number={2} state="todo" title="새 창에서 연결을 허용해요">
          {ai.message ? (
            <Banner tone="danger" role="alert">
              {ai.message}
            </Banner>
          ) : null}
          <Button
            variant="ai"
            loading={ai.connecting}
            onClick={() => void ai.connect()}
          >
            내 AI 구독 연결
          </Button>
        </Step>
      </ol>
    );
  const login = ai.deviceLogin;
  return (
    <div className="connect">
      <ol className="connect" aria-label="AI 연결 단계">
        <Step
          number={1}
          state={login ? "done" : "now"}
          title="OpenAI 보안 설정에서 ‘Codex용 장치 코드 인증’을 켜요"
        >
          <ButtonLink
            size="sm"
            icon="external"
            href={CHATGPT_SECURITY_URL}
            target="_blank"
            rel="noreferrer"
          >
            보안 설정 열기
          </ButtonLink>
        </Step>
        <Step
          number={2}
          state={login ? "done" : "todo"}
          title="연결 코드를 받아요"
        >
          {login ? (
            <div className="connect-code">
              <code>{login.userCode}</code>
              <Button
                size="sm"
                icon={ai.codeCopied ? "check" : "copy"}
                onClick={() => void ai.copyCode()}
              >
                {ai.codeCopied ? "복사됨" : "코드 복사"}
              </Button>
            </div>
          ) : (
            <>
              {ai.message ? (
                <Banner tone="danger" role="alert">
                  {ai.message}
                </Banner>
              ) : null}
              <Button
                variant="ai"
                loading={ai.connecting}
                onClick={() => void ai.connect()}
              >
                연결 코드 받기
              </Button>
            </>
          )}
        </Step>
        <Step
          number={3}
          state={login ? "now" : "todo"}
          title="OpenAI 화면에 코드를 입력해요"
        >
          {login ? (
            <>
              <ButtonLink
                size="sm"
                variant="primary"
                icon="external"
                href={login.verificationUrl}
                target="_blank"
                rel="noreferrer"
              >
                OpenAI 코드 입력 화면 열기
              </ButtonLink>
              <p className="connect-status" role="status">
                <Spinner /> 승인을 기다리고 있어요. 승인되면 저절로 연결돼요.
              </p>
              <div>
                <Button
                  size="sm"
                  variant="quiet"
                  icon="refresh"
                  loading={ai.connecting}
                  onClick={() => void ai.connect()}
                >
                  새 코드 받기
                </Button>
              </div>
            </>
          ) : null}
        </Step>
      </ol>
      <p className="connect-note">
        로그인은 OpenAI 화면에서 해요. 이 서비스는 비밀번호를 받지 않아요.
      </p>
    </div>
  );
}
