// 최초 실행 시 계정 동기화 또는 로컬 전용 사용 방식을 선택하도록 안내한다
import { useState, type FormEvent } from "react";
import { Icon } from "./Icon";

interface OnboardingScreenProps {
  authEnabled: boolean;
  onSignInWithGoogle: () => Promise<void> | void;
  onSendMagicLink: (email: string) => Promise<void>;
  onContinueLocal: () => void;
}

export function OnboardingScreen(props: OnboardingScreenProps) {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState<"google" | "email">();
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);

  async function signInWithGoogle() {
    setPending("google");
    setMessage("");
    setError(false);
    try {
      await props.onSignInWithGoogle();
      setMessage("브라우저에서 Google 로그인을 완료해 주세요.");
    } catch (cause) {
      setError(true);
      setMessage(cause instanceof Error ? cause.message : "Google 로그인을 시작하지 못했습니다.");
    } finally {
      setPending(undefined);
    }
  }

  async function sendMagicLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending("email");
    setMessage("");
    setError(false);
    try {
      await props.onSendMagicLink(email.trim());
      setMessage("로그인 링크를 보냈습니다. 이메일에서 링크를 열어 주세요.");
    } catch (cause) {
      setError(true);
      setMessage(cause instanceof Error ? cause.message : "로그인 링크를 보내지 못했습니다.");
    } finally {
      setPending(undefined);
    }
  }

  return (
    <main className="onboarding-shell">
      <div className="onboarding-grid" aria-hidden="true" />
      <section className="onboarding-intro" aria-labelledby="onboarding-title">
        <div className="onboarding-brand"><span><Icon name="activity" /></span><strong>TOKEN <i>DECK</i></strong></div>
        <p className="onboarding-kicker">AI USAGE, ONE ACCOUNT</p>
        <h1 id="onboarding-title">모든 기기의 토큰 흐름을<br /><em>한 계정으로 연결하세요.</em></h1>
        <p className="onboarding-description">Codex, Claude, Gemini의 사용량은 이 기기에서 안전하게 수집됩니다. 로그인하면 여러 기기의 수치만 하나로 합쳐집니다.</p>
        <ul className="onboarding-points" aria-label="Token Deck 주요 특징">
          <li><span>01</span><div><strong>로컬 우선 수집</strong><small>프롬프트와 코드는 전송하지 않습니다.</small></div></li>
          <li><span>02</span><div><strong>기기 간 동기화</strong><small>같은 계정의 사용량을 자동으로 합칩니다.</small></div></li>
          <li><span>03</span><div><strong>언제든 선택 가능</strong><small>로그인 없이 로컬 전용으로 시작할 수 있습니다.</small></div></li>
        </ul>
      </section>

      <section className="onboarding-auth" aria-labelledby="onboarding-auth-title">
        <div className="onboarding-step"><span>STEP 01</span><i /></div>
        <h2 id="onboarding-auth-title">사용 방식을 선택하세요.</h2>
        <p>로그인하면 이 PC와 다른 기기의 사용량을 한곳에서 확인할 수 있습니다.</p>

        {!props.authEnabled && <div className="onboarding-notice" role="status"><Icon name="warning" /><span>운영 동기화 서버 설정이 없는 빌드입니다. 공식 배포본을 다시 설치하거나 관리자에게 문의해 주세요.</span></div>}

        <button className="google-login-button" type="button" disabled={!props.authEnabled || Boolean(pending)} onClick={() => void signInWithGoogle()}>
          <span aria-hidden="true">G</span>{pending === "google" ? "브라우저 여는 중…" : "Google로 계속하기"}
        </button>

        <div className="onboarding-divider"><span>또는 이메일로 로그인</span></div>

        <form className="onboarding-email" onSubmit={sendMagicLink}>
          <label htmlFor="onboarding-email">이메일 주소</label>
          <div><input id="onboarding-email" type="email" autoComplete="email" required disabled={!props.authEnabled || Boolean(pending)} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /><button type="submit" disabled={!props.authEnabled || Boolean(pending)}>{pending === "email" ? "전송 중…" : "로그인 링크 받기"}</button></div>
        </form>

        <p className={`onboarding-message ${error ? "error" : ""}`} aria-live="polite">{message}</p>

        <button className="local-start-button" type="button" disabled={Boolean(pending)} onClick={props.onContinueLocal}>로그인 없이 로컬 전용으로 시작</button>
        <p className="onboarding-privacy"><Icon name="lock" /> 나중에 설정에서 로그인하고 동기화를 시작할 수 있습니다.</p>
      </section>
    </main>
  );
}
