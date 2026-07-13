// 최초 실행 시 계정 동기화 또는 로컬 전용 사용 방식을 선택하도록 안내한다
import { useState, type FormEvent } from "react";
import { Icon } from "./Icon";

interface OnboardingScreenProps {
  authEnabled: boolean;
  authError?: string;
  onSignInWithGoogle: () => Promise<void> | void;
  onSendMagicLink: (email: string) => Promise<void>;
  onContinueLocal: () => void;
}

export function OnboardingScreen(props: OnboardingScreenProps) {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState<"google" | "email">();
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const visibleMessage = props.authError?.trim() || message;
  const visibleError = Boolean(props.authError?.trim()) || error;

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
        <p className="onboarding-description">Codex, Claude, Gemini의 사용량은 이 기기에서 안전하게 수집됩니다. 로그인하면 여러 기기의 사용량과 프로젝트·도구 목록 메타데이터를 한 계정으로 연결할 수 있습니다.</p>
        <ul className="onboarding-points" aria-label="Token Deck 주요 특징">
          <li><span>01</span><div><strong>로컬 우선 수집</strong><small>프롬프트와 코드는 전송하지 않습니다.</small></div></li>
          <li><span>02</span><div><strong>기기 간 동기화</strong><small>사용량, 표시용 프로젝트 이름과 기기 도구 현황을 연결합니다.</small></div></li>
          <li><span>03</span><div><strong>언제든 선택 가능</strong><small>로그인 없이 로컬 전용으로 시작할 수 있습니다.</small></div></li>
        </ul>
      </section>

      <section className="onboarding-auth" aria-labelledby="onboarding-auth-title">
        <div className="onboarding-step"><span>STEP 01</span><i /></div>
        <h2 id="onboarding-auth-title">사용 방식을 선택하세요.</h2>
        <p>로그인하면 이 PC와 다른 기기의 사용량과 설정 현황을 한곳에서 확인할 수 있습니다.</p>

        {!props.authEnabled && <div className="onboarding-notice" role="status"><Icon name="warning" /><span>운영 동기화 서버 설정이 없는 빌드입니다. 공식 배포본을 다시 설치하거나 관리자에게 문의해 주세요.</span></div>}

        <div className="onboarding-notice onboarding-sync-disclosure" role="note"><Icon name="lock" /><span>로그인하면 AI 도구·모델, 토큰 수치·사용 시각, 익명 프로젝트·세션·기기 식별자, 표시용 프로젝트·세션 제목, 기기 이름·OS·앱 버전·최근 연결 시각과 연결한 공급사의 토큰·비용 집계를 계정에 저장합니다. 로그인과 함께 이 기기의 도구 목록 공유도 켜며, 목록 시각·비교 해시와 스킬·MCP·플러그인의 공급사·종류·ID·이름·버전·설치·활성 상태·출처·마켓플레이스·연결 방식·비밀 설정 필요 여부·가져오기 가능 여부와 제한 사유 분류를 추가 저장합니다. 코드, 프롬프트·응답, 전체 경로, Git 원격 주소 원문, 스킬 본문, MCP 명령·인수·URL, 환경변수, API 키·OAuth 토큰과 비밀값은 전송하지 않으며 로그인 후 설정에서 도구 목록 공유를 끌 수 있습니다.</span></div>

        <button className="google-login-button" type="button" disabled={!props.authEnabled || Boolean(pending)} onClick={() => void signInWithGoogle()}>
          <span aria-hidden="true">G</span>{pending === "google" ? "브라우저 여는 중…" : "Google로 계속하기"}
        </button>

        <div className="onboarding-divider"><span>또는 이메일로 로그인</span></div>

        <form className="onboarding-email" onSubmit={sendMagicLink}>
          <label htmlFor="onboarding-email">이메일 주소</label>
          <div><input id="onboarding-email" type="email" autoComplete="email" required disabled={!props.authEnabled || Boolean(pending)} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /><button type="submit" disabled={!props.authEnabled || Boolean(pending)}>{pending === "email" ? "전송 중…" : "로그인 링크 받기"}</button></div>
        </form>

        <p className={`onboarding-message ${visibleError ? "error" : ""}`} aria-live="polite">{visibleMessage}</p>

        <button className="local-start-button" type="button" disabled={Boolean(pending)} onClick={props.onContinueLocal}>로그인 없이 로컬 전용으로 시작</button>
        <p className="onboarding-privacy"><Icon name="lock" /> 나중에 설정에서 로그인하고 동기화를 시작할 수 있습니다.</p>
      </section>
    </main>
  );
}
