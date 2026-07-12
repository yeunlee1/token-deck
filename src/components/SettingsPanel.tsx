// 계정 동기화와 공급사 자격 증명, 세션 제목을 관리하는 설정 대화상자
import { useEffect, useState, type FormEvent } from "react";
import type { ChartPeriod } from "./chart-data";
import type { Provider } from "../core";
import type { AutostartStatus, GeminiStatus } from "../platform/native";
import type { ProviderUsageRecord } from "../services";
import { Icon } from "./Icon";

type CredentialProvider = "openai" | "anthropic" | "google";

interface CredentialState {
  configured: boolean;
  checking: boolean;
  error?: string;
}

interface SessionOption {
  id: string;
  provider: Provider;
  title: string;
  occurredAt: string;
}

interface SettingsPanelProps {
  open: boolean;
  auth: { enabled: boolean; status: "local" | "signed_out" | "authenticated"; userId?: string; error?: string };
  cloudSync: { status: string; uploaded: number; pending: number; lastSyncedAt?: Date; error?: string };
  credentials: Record<CredentialProvider, CredentialState>;
  gemini: GeminiStatus;
  autostart: AutostartStatus;
  nativeBusy: boolean;
  nativeMessage: string;
  providerUsage: ProviderUsageRecord[];
  sessions: SessionOption[];
  displayProviders: Provider[];
  miniTotalVisible: boolean;
  miniTotalPeriod: ChartPeriod;
  inventorySyncEnabled: boolean;
  inventorySyncBusy: boolean;
  claudeQuotaCapture: { configured: boolean; hasData: boolean; existingStatusLine: boolean };
  quotaBusy: boolean;
  onClose: () => void;
  onConfigureSupabase: (url: string, anonKey: string) => Promise<void> | void;
  onClearSupabaseConfig: () => Promise<void> | void;
  onSendMagicLink: (email: string) => Promise<void>;
  onSignInWithGoogle: () => Promise<void> | void;
  onSignOut: () => Promise<void> | void;
  onSaveCredential: (provider: CredentialProvider, credentials: Record<string, string>) => Promise<void>;
  onRemoveCredential: (provider: CredentialProvider) => Promise<void>;
  onRefreshProvider: (provider: CredentialProvider) => Promise<void>;
  onUpdateSessionTitle: (sessionId: string, title: string) => Promise<void>;
  onSetAutostart: (enabled: boolean) => Promise<void>;
  onConfigureGemini: () => Promise<void>;
  onToggleDisplayProvider: (provider: Provider) => void;
  onToggleMiniTotal: () => void;
  onConfigureClaudeQuota: () => Promise<void>;
  onSetInventorySyncEnabled: (enabled: boolean) => Promise<void>;
}

const providerLabels: Record<CredentialProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google Cloud",
};

function CredentialForm({ provider, state, onSave, onRemove, onRefresh }: {
  provider: CredentialProvider;
  state: CredentialState;
  onSave: SettingsPanelProps["onSaveCredential"];
  onRemove: SettingsPanelProps["onRemoveCredential"];
  onRefresh: SettingsPanelProps["onRefreshProvider"];
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setBusy(true);
    setMessage("");
    try {
      const form = new FormData(formElement);
      const credentials = Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value).trim()]));
      await onSave(provider, credentials);
      formElement.reset();
      setMessage("안전하게 저장했습니다.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await onRemove(provider);
      setMessage("저장된 자격 증명을 삭제했습니다.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "삭제하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setBusy(true);
    setMessage("");
    try {
      await onRefresh(provider);
      setMessage("최근 30일 사용량을 불러왔습니다.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "사용량을 불러오지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="credential-form" onSubmit={submit}>
      <div className="setting-row-heading">
        <div><strong>{providerLabels[provider]}</strong><small>{state.configured ? "이 기기에 자격 증명 저장됨" : "연결되지 않음"}</small></div>
        <span className={`connection-badge ${state.configured ? "connected" : ""}`}><i />{state.checking ? "확인 중" : state.configured ? "연결됨" : "대기"}</span>
      </div>
      <div className="credential-fields">
        {provider === "openai" && <><label>Admin API key<input name="adminApiKey" type="password" autoComplete="off" required placeholder="sk-admin-…" /></label><label>Organization ID <em>선택</em><input name="organizationId" autoComplete="off" placeholder="org-…" /></label></>}
        {provider === "anthropic" && <label>Admin API key<input name="adminApiKey" type="password" autoComplete="off" required placeholder="sk-ant-admin-…" /></label>}
        {provider === "google" && <><label>Access token<input name="accessToken" type="password" autoComplete="off" required /></label><label>Query project ID<input name="queryProjectId" required /></label><label>Billing table<input name="billingTable" required placeholder="project.dataset.table" /></label><label>Location <em>선택</em><input name="location" placeholder="US" /></label></>}
      </div>
      <div className="setting-actions">
        <button className="primary-button" disabled={busy || state.checking}>{busy ? "처리 중…" : "저장"}</button>
        {state.configured && <><button type="button" className="secondary-button" disabled={busy} onClick={() => void refresh()}>사용량 새로고침</button><button type="button" className="danger-button" disabled={busy} onClick={() => void remove()}>삭제</button></>}
      </div>
      <p className={`form-message ${state.error ? "error" : ""}`} aria-live="polite">{state.error ?? message}</p>
    </form>
  );
}

export function SettingsPanel(props: SettingsPanelProps) {
  const [email, setEmail] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [authBusy, setAuthBusy] = useState<"google" | "email">();
  const [supabaseUrl, setSupabaseUrl] = useState("");
  const [supabaseAnonKey, setSupabaseAnonKey] = useState("");
  const [sessionId, setSessionId] = useState(props.sessions[0]?.id ?? "");
  const selectedSession = props.sessions.find((session) => session.id === sessionId);
  const [sessionTitle, setSessionTitle] = useState("");
  const providerTokens = props.providerUsage.reduce((total, item) => total + (item.inputTokens ?? 0) + (item.cachedTokens ?? 0) + (item.outputTokens ?? 0), 0);
  const providerCost = props.providerUsage.reduce((total, item) => total + (item.amount ?? 0), 0);

  useEffect(() => {
    if (props.open && !props.sessions.some((session) => session.id === sessionId)) setSessionId(props.sessions[0]?.id ?? "");
  }, [props.open, props.sessions, sessionId]);

  if (!props.open) return null;

  async function login(event: FormEvent) {
    event.preventDefault();
    setAuthMessage("");
    setAuthBusy("email");
    try {
      await props.onSendMagicLink(email);
      setAuthMessage("로그인 링크를 이메일로 보냈습니다.");
    } catch (cause) {
      setAuthMessage(cause instanceof Error ? cause.message : "로그인 링크를 보내지 못했습니다.");
    } finally {
      setAuthBusy(undefined);
    }
  }

  async function loginWithGoogle() {
    setAuthMessage("");
    setAuthBusy("google");
    try {
      await props.onSignInWithGoogle();
      setAuthMessage("브라우저에서 Google 로그인을 완료해 주세요.");
    } catch (cause) {
      setAuthMessage(cause instanceof Error ? cause.message : "Google 로그인을 시작하지 못했습니다.");
    } finally {
      setAuthBusy(undefined);
    }
  }

  async function configureSupabase(event: FormEvent) {
    event.preventDefault();
    setAuthMessage("");
    try {
      await props.onConfigureSupabase(supabaseUrl.trim(), supabaseAnonKey.trim());
      setSupabaseAnonKey("");
      setAuthMessage("Supabase 연결 정보를 저장했습니다.");
    } catch (cause) {
      setAuthMessage(cause instanceof Error ? cause.message : "Supabase 연결 정보를 저장하지 못했습니다.");
    }
  }

  async function saveTitle(event: FormEvent) {
    event.preventDefault();
    if (!sessionId || !sessionTitle.trim()) return;
    await props.onUpdateSessionTitle(sessionId, sessionTitle.trim());
    setSessionTitle("");
  }

  async function toggleInventorySync() {
    setAuthMessage("");
    try {
      await props.onSetInventorySyncEnabled(!props.inventorySyncEnabled);
      setAuthMessage(props.inventorySyncEnabled ? "이 기기의 도구 목록 자동 갱신을 껐습니다." : "이 기기의 도구 목록 자동 갱신을 켰습니다.");
    } catch (cause) {
      setAuthMessage(cause instanceof Error ? cause.message : "기기 설정 목록 동기화 상태를 바꾸지 못했습니다.");
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}>
      <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings-header"><div><span className="eyebrow">TOKEN DECK CONTROL</span><h2 id="settings-title">연결 및 동기화 설정</h2><p>계정과 공급사 연결 정보는 이 기기에서 안전하게 관리됩니다.</p></div><button className="modal-close" aria-label="설정 닫기" onClick={props.onClose}>×</button></header>
        <div className="settings-scroll">
          <section className="setting-section" aria-labelledby="account-title">
            <div className="setting-section-title"><span className="setting-icon"><Icon name="cloud" /></span><div><h3 id="account-title">기기 간 계정 동기화</h3><p>같은 이메일로 로그인한 Windows 기기의 사용량을 합칩니다.</p></div></div>
            <details className="supabase-config" open={!props.auth.enabled}>
              <summary>Supabase 서버 연결 {props.auth.enabled && <span>설정됨</span>}</summary>
              <form onSubmit={configureSupabase}>
                <label>Project URL<input type="url" required value={supabaseUrl} onChange={(event) => setSupabaseUrl(event.target.value)} placeholder="https://project.supabase.co" /></label>
                <label>Publishable key<input type="password" required value={supabaseAnonKey} onChange={(event) => setSupabaseAnonKey(event.target.value)} autoComplete="off" placeholder="sb_publishable_…" /></label>
                <div className="setting-actions"><button className="primary-button">연결 정보 저장</button>{props.auth.enabled && <button type="button" className="danger-button" onClick={() => void props.onClearSupabaseConfig()}>설정 지우기</button>}</div>
              </form>
              <p>프로젝트 URL과 공개 publishable key만 저장합니다. Secret 또는 service role key는 입력하지 마세요.</p>
            </details>
            {!props.auth.enabled || props.auth.status === "local" ? <div className="setting-notice"><Icon name="warning" /><div><strong>로컬 전용 모드</strong><p>Supabase 환경 설정을 추가하면 Google·이메일 로그인과 기기 동기화가 활성화됩니다.</p></div></div> : props.auth.status === "authenticated" ? <div className="signed-in-card"><div><span className="avatar">TD</span><div><strong>동기화 계정 연결됨</strong><small>{props.auth.userId ?? "인증된 사용자"}</small></div></div><button className="secondary-button" onClick={() => void props.onSignOut()}>로그아웃</button></div> : <div className="settings-auth-options"><button className="google-login-button compact" type="button" disabled={Boolean(authBusy)} onClick={() => void loginWithGoogle()}><span aria-hidden="true">G</span>{authBusy === "google" ? "브라우저 여는 중…" : "Google로 로그인"}</button><span className="settings-auth-divider">또는</span><form className="login-form" onSubmit={login}><label htmlFor="sync-email">이메일 주소</label><div><input id="sync-email" type="email" autoComplete="email" required disabled={Boolean(authBusy)} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /><button className="primary-button" disabled={Boolean(authBusy)}>{authBusy === "email" ? "전송 중…" : "로그인 링크 받기"}</button></div></form></div>}
            <p className="form-message" aria-live="polite">{props.auth.error ?? authMessage}</p>
            <div className="sync-summary"><span><b>{props.cloudSync.pending}</b>개 업로드 대기</span><span><b>{props.cloudSync.uploaded}</b>개 동기화됨</span><span>상태 <b>{props.cloudSync.status}</b></span></div>
            <div className="setting-toggle-row"><div><strong>이 기기의 도구 목록 자동 갱신</strong><small>기기 식별자, 목록 스키마 버전, 수집·갱신 시각, 내용 비교용 해시와 도구의 종류, 공급사, 항목 ID·이름, 버전, 설치·활성 상태, 수집 출처 분류, 마켓플레이스, MCP 전송 방식, 비밀 설정 필요 여부, 자동 가져오기 가능 여부와 제한 사유 분류만 공유합니다. 비밀값, 명령, 제한 사유의 원문과 전체 경로는 제외됩니다. 갱신을 꺼도 마지막 스냅샷은 계정 비교용으로 유지됩니다.</small></div><button className={`toggle setting-switch ${props.inventorySyncEnabled ? "on" : ""}`} type="button" role="switch" aria-checked={props.inventorySyncEnabled} aria-label="이 기기의 도구 목록 자동 갱신" disabled={props.auth.status !== "authenticated" || props.inventorySyncBusy} onClick={() => void toggleInventorySync()}><span /></button></div>
          </section>

          <section className="setting-section" aria-labelledby="display-title">
            <div className="setting-section-title"><span className="setting-icon"><Icon name="activity" /></span><div><h3 id="display-title">대시보드 표시 항목</h3><p>개요, 프로젝트와 기기 화면에서 보고 싶은 공급사를 선택합니다.</p></div></div>
            <div className="provider-visibility" aria-label="대시보드에 표시할 공급사">{(["codex", "claude", "gemini"] as Provider[]).map((provider) => <button key={provider} type="button" aria-pressed={props.displayProviders.includes(provider)} onClick={() => props.onToggleDisplayProvider(provider)}><span className={`project-dot ${provider === "claude" ? "lime" : provider === "gemini" ? "violet" : "ink"}`} /><strong>{provider === "codex" ? "Codex" : provider === "claude" ? "Claude" : "Gemini"}</strong><small>{props.displayProviders.includes(provider) ? "표시 중" : "숨김"}</small></button>)}</div>
            <p className="setting-hint">최소 한 개는 항상 표시됩니다. 수집과 동기화는 선택과 관계없이 계속됩니다.</p>
            <div className="setting-toggle-row"><div><strong>미니모드 총 토큰</strong><small>미니모드에서 선택한 공급사의 {props.miniTotalPeriod} 사용량 합계를 표시합니다.</small></div><button className={`toggle setting-switch ${props.miniTotalVisible ? "on" : ""}`} type="button" role="switch" aria-checked={props.miniTotalVisible} aria-label="미니모드 총 토큰 표시" onClick={props.onToggleMiniTotal}><span /></button></div>
          </section>

          <section className="setting-section" aria-labelledby="quota-title">
            <div className="setting-section-title"><span className="setting-icon"><Icon name="activity" /></span><div><h3 id="quota-title">정액제 잔여 한도</h3><p>Codex와 Claude가 제공하는 5시간·주간 잔여 퍼센트를 표시합니다.</p></div><span className={`connection-badge ${props.claudeQuotaCapture.hasData ? "connected" : ""}`}><i />{props.claudeQuotaCapture.hasData ? "Claude 연결됨" : "Claude 설정 필요"}</span></div>
            {props.claudeQuotaCapture.configured ? <div className="signed-in-card"><div><span className="avatar">CL</span><div><strong>Claude 한도 수집 활성</strong><small>{props.claudeQuotaCapture.hasData ? "최근 정액제 한도 데이터를 받았습니다." : "Claude Code를 한 번 실행하면 한도 정보가 표시됩니다."}</small></div></div></div> : <div className="setting-notice"><Icon name="warning" /><div><strong>{props.claudeQuotaCapture.existingStatusLine ? "기존 Claude 상태 표시 설정이 있습니다." : "Claude 한도 연동이 꺼져 있습니다."}</strong><p>{props.claudeQuotaCapture.existingStatusLine ? "기존 설정을 보호하기 위해 자동으로 덮어쓰지 않습니다." : "Claude Code 상태 표시에서 토큰 내용 없이 잔여 퍼센트만 로컬로 전달합니다."}</p>{!props.claudeQuotaCapture.existingStatusLine && <button className="primary-button inline-action" disabled={props.quotaBusy} onClick={() => void props.onConfigureClaudeQuota()}>{props.quotaBusy ? "설정 중…" : "Claude 한도 연동"}</button>}</div></div>}
          </section>

          <section className="setting-section" aria-labelledby="providers-title">
            <div className="setting-section-title"><span className="setting-icon"><Icon name="lock" /></span><div><h3 id="providers-title">공급사 자격 증명</h3><p>비밀 값은 Windows Credential Manager에만 저장됩니다.</p></div></div>
            <div className="credential-stack">{(["openai", "anthropic", "google"] as CredentialProvider[]).map((provider) => <CredentialForm key={provider} provider={provider} state={props.credentials[provider]} onSave={props.onSaveCredential} onRemove={props.onRemoveCredential} onRefresh={props.onRefreshProvider} />)}</div>
            <div className="sync-summary"><span><b>{props.providerUsage.length}</b>개 API 집계</span><span><b>{providerTokens.toLocaleString("ko-KR")}</b> tokens</span><span><b>{providerCost.toFixed(2)}</b> 비용 합계</span></div>
          </section>

          <section className="setting-section" aria-labelledby="gemini-title">
            <div className="setting-section-title"><span className="setting-icon"><Icon name="code" /></span><div><h3 id="gemini-title">Gemini CLI 수집</h3><p>로컬 OpenTelemetry 사용 이벤트에서 토큰 수치만 읽습니다.</p></div><span className={`connection-badge ${props.gemini.telemetryConfigured ? "connected" : ""}`}><i />{props.gemini.telemetryConfigured ? "사용자 설정 완료" : props.gemini.installed ? "설정 필요" : "설치 필요"}</span></div>
            {!props.gemini.installed ? <div className="setting-notice"><Icon name="warning" /><div><strong>Gemini CLI를 찾지 못했습니다.</strong><p>Gemini CLI 설치 후 다시 확인하세요.</p><code>npm install -g @google/gemini-cli</code></div></div> : <div className="signed-in-card"><div><span className="avatar">GM</span><div><strong>Gemini CLI {props.gemini.version ?? ""}</strong><small>{props.gemini.telemetryConfigured ? "사용자 설정에서 프롬프트 로깅 제외" : "토큰 텔레메트리 설정 필요"}</small></div></div>{!props.gemini.telemetryConfigured && <button className="primary-button" disabled={props.nativeBusy} onClick={() => void props.onConfigureGemini()}>안전 수집 활성화</button>}</div>}
            {props.gemini.telemetryConfigured && <div className="setting-notice"><Icon name="warning" /><div><strong>사용자 설정 기준 상태입니다.</strong><p>프로젝트 설정이나 환경 변수가 Gemini 설정을 덮어쓸 수 있습니다. Token Deck은 동기화할 때 토큰 수치만 전송합니다.</p></div></div>}
            <p className="form-message" aria-live="polite">{props.nativeMessage}</p>
          </section>

          <section className="setting-section" aria-labelledby="startup-title">
            <div className="setting-section-title"><span className="setting-icon"><Icon name="device" /></span><div><h3 id="startup-title">Windows 자동 시작</h3><p>로그인할 때 창을 띄우지 않고 트레이에서 수집을 시작합니다.</p></div></div>
            <div className="signed-in-card"><div><span className="avatar">PC</span><div><strong>{props.autostart.enabled ? "자동 시작 사용 중" : "자동 시작 꺼짐"}</strong><small>{props.autostart.supported ? "현재 Windows 사용자에게만 적용" : "데스크톱 앱에서 설정 가능"}</small></div></div><button className={props.autostart.enabled ? "danger-button" : "primary-button"} disabled={!props.autostart.supported || props.nativeBusy} onClick={() => void props.onSetAutostart(!props.autostart.enabled)}>{props.autostart.enabled ? "해제" : "활성화"}</button></div>
          </section>

          <section className="setting-section" aria-labelledby="sessions-title">
            <div className="setting-section-title"><span className="setting-icon"><Icon name="spark" /></span><div><h3 id="sessions-title">세션 제목</h3><p>프롬프트 내용 대신 알아보기 쉬운 이름만 동기화합니다.</p></div></div>
            {props.sessions.length ? <form className="session-title-form" onSubmit={saveTitle}><label>세션<select value={sessionId} onChange={(event) => { setSessionId(event.target.value); setSessionTitle(""); }}>{props.sessions.map((session) => <option value={session.id} key={session.id}>{session.title || `${session.provider} · ${new Date(session.occurredAt).toLocaleString("ko-KR")}`}</option>)}</select></label><label>새 제목<input value={sessionTitle} onChange={(event) => setSessionTitle(event.target.value)} maxLength={80} placeholder={selectedSession?.title || "예: 결제 대시보드 작업"} required /></label><button className="primary-button">제목 저장</button></form> : <p className="empty-state">수집된 세션이 생기면 여기에서 제목을 지정할 수 있습니다.</p>}
          </section>
        </div>
      </section>
    </div>
  );
}
