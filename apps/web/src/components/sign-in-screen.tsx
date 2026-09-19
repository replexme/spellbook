import { Banner, Brand, Button, ButtonLink, TextField } from "@/design-system";
import { SignInScene } from "./sign-in-scene";

/**
 * Sign-in for both deployments: an external account (managed) or the local
 * administrator account set at install time (self-hosted).
 */
export function SignInScreen({
  mode,
  error,
  destination = "/",
}: {
  mode: "external" | "local";
  error?: string | null;
  destination?: string;
}) {
  return (
    <main className="signin">
      <section className="signin-main">
        <Brand />
        <h1>
          AI가 화면을 보고 고치고,
          <br />
          다시 보고 확인합니다
        </h1>
        <p>
          가진 PowerPoint 파일을 그대로 열어 필요한 곳만 고쳐요. 무엇을 바꿨고
          무엇을 확인했는지 보여주고, 원본은 버전 기록에 늘 남겨 둬요.
        </p>
        {error ? (
          <Banner tone="danger" role="alert">
            {error}
          </Banner>
        ) : null}
        {mode === "external" ? (
          <div className="signin-form">
            <ButtonLink variant="primary" size="lg" block href="/auth/login">
              계정으로 계속
            </ButtonLink>
            <p className="signin-note">
              연결된 계정으로 로그인해요. 문서와 작업 기록은 계정마다 따로
              보관해요.
            </p>
          </div>
        ) : (
          <form className="signin-form" action="/auth/login" method="post">
            <input type="hidden" name="redirect" value={destination} />
            <TextField
              label="이메일"
              name="email"
              type="email"
              autoComplete="username"
              required
            />
            <TextField
              label="비밀번호"
              name="password"
              type="password"
              autoComplete="current-password"
              minLength={12}
              required
            />
            <Button variant="primary" size="lg" block type="submit">
              로그인
            </Button>
            <p className="signin-note">
              설치할 때 만든 관리자 계정으로 로그인해요. 계정 값은 서버의
              .env에서 관리해요.
            </p>
          </form>
        )}
      </section>
      <aside className="signin-visual" aria-hidden="true">
        <SignInScene />
      </aside>
    </main>
  );
}
