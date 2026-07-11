// AI 도구별 실제 토큰 사용량과 계정 연결 상태를 통합해 보여주는 데스크톱 대시보드
import { useEffect, useMemo, useState } from "react";
import { buildUsageChart, type ChartPeriod } from "./components/chart-data";
import { Icon, type IconName } from "./components/Icon";
import { MiniDashboard } from "./components/MiniDashboard";
import { SettingsPanel } from "./components/SettingsPanel";
import { UsageChart } from "./components/UsageChart";
import { quotaStatusLabel, remainingLabel, remainingTone } from "./components/quota-display";
import { tokenTotal, type Provider, type UsageEvent } from "./core";
import { useAppRuntime } from "./hooks/useAppRuntime";
import { getOrCreateDeviceId } from "./hooks/useLocalUsage";
import { useNativeSettings } from "./hooks/useNativeSettings";
import { useProviderQuotas } from "./hooks/useProviderQuotas";
import { applyWindowMode } from "./platform/window-mode";
import "./styles.css";

type Period = ChartPeriod;
type ActiveView = "overview" | "projects" | "devices";
const MINI_MODE_KEY = "token-deck-mini-mode";
const MINI_PROVIDERS_KEY = "token-deck-mini-providers";
const MINI_OPACITY_KEY = "token-deck-mini-opacity";
const DISPLAY_PROVIDERS_KEY = "token-deck-display-providers";
const ALL_PROVIDERS: Provider[] = ["codex", "claude", "gemini"];

const providerInfo = {
  codex: { name: "Codex", model: "앱 + CLI", tone: "ink", monogram: "CX" },
  claude: { name: "Claude", model: "Claude Code", tone: "lime", monogram: "CL" },
  gemini: { name: "Gemini", model: "Gemini CLI", tone: "violet", monogram: "GM" },
} as const;

function formatTokens(value: number): string {
  return new Intl.NumberFormat("ko-KR", { notation: value > 9999 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function periodStart(period: Period): Date {
  const start = new Date();
  if (period === "오늘") start.setHours(0, 0, 0, 0);
  else {
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (period === "7일" ? 6 : 29));
  }
  return start;
}

function usageInPeriod(events: UsageEvent[], period: Period): UsageEvent[] {
  const start = periodStart(period).getTime();
  return events.filter((event) => new Date(event.occurredAt).getTime() >= start);
}

function SectionTitle({ eyebrow, title, action }: { eyebrow: string; title: string; action?: React.ReactNode }) {
  return <div className="section-title"><div><span>{eyebrow}</span><h2>{title}</h2></div>{action}</div>;
}

export default function App() {
  const runtime = useAppRuntime();
  const nativeSettings = useNativeSettings();
  const providerQuotas = useProviderQuotas();
  const [currentDeviceId] = useState(() => getOrCreateDeviceId());
  const [period, setPeriod] = useState<Period>("7일");
  const [activeView, setActiveView] = useState<ActiveView>("overview");
  const [miniMode, setMiniMode] = useState(() => window.localStorage.getItem(MINI_MODE_KEY) === "true");
  const [displayProviders, setDisplayProviders] = useState<Provider[]>(() => readProviderList(DISPLAY_PROVIDERS_KEY, ALL_PROVIDERS));
  const [miniProviders, setMiniProviders] = useState<Provider[]>(() => readProviderList(MINI_PROVIDERS_KEY, ["codex", "claude"]));
  const [miniOpacity, setMiniOpacity] = useState(() => readOpacity());
  const [windowModeError, setWindowModeError] = useState("");
  const [privacy, setPrivacy] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const usageEvents = runtime.combinedEvents;
  const visibleEvents = useMemo(() => usageEvents.filter((event) => displayProviders.includes(event.provider)), [displayProviders, usageEvents]);
  const periodEvents = useMemo(() => usageInPeriod(visibleEvents, period), [visibleEvents, period]);
  const actualTotal = useMemo(() => periodEvents.reduce((sum, event) => sum + tokenTotal(event.tokens), 0), [periodEvents]);
  const chartData = useMemo(() => buildUsageChart(visibleEvents, period), [visibleEvents, period]);

  useEffect(() => {
    if (!settingsOpen) return;
    const close = (event: KeyboardEvent) => event.key === "Escape" && setSettingsOpen(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [settingsOpen]);

  useEffect(() => {
    if (!miniMode) return;
    void applyWindowMode(true).catch((cause) => {
      setMiniMode(false);
      window.localStorage.removeItem(MINI_MODE_KEY);
      setWindowModeError(cause instanceof Error ? cause.message : "미니 창으로 전환하지 못했습니다.");
    });
  }, []);

  const providers = useMemo(() => {
    const totals = displayProviders.map((provider) => ({
      provider,
      tokens: periodEvents.filter((event) => event.provider === provider).reduce((sum, event) => sum + tokenTotal(event.tokens), 0),
    }));
    return totals.map(({ provider, tokens }) => ({
      ...providerInfo[provider],
      value: formatTokens(tokens),
      percent: actualTotal ? Math.round(tokens / actualTotal * 100) : 0,
      status: runtime.integrations[provider] ? (tokens ? "수집됨" : "연결됨") : "미감지",
      quota: providerQuotas.quotas[provider],
    }));
  }, [actualTotal, displayProviders, periodEvents, providerQuotas.quotas, runtime.integrations]);

  const projects = useMemo(() => {
    const grouped = new Map<string, UsageEvent[]>();
    periodEvents.forEach((event) => grouped.set(event.projectId, [...(grouped.get(event.projectId) ?? []), event]));
    const totals = [...grouped.entries()].map(([id, events]) => ({ id, events, value: events.reduce((sum, event) => sum + tokenTotal(event.tokens), 0) }));
    const max = Math.max(...totals.map((project) => project.value), 1);
    return totals.sort((a, b) => b.value - a.value).map(({ id, events, value }, index) => ({
      id,
      name: `프로젝트 ${id.slice(-6).toUpperCase()}`,
      path: id.startsWith("git_") ? "Git 원격으로 기기 간 통합" : "익명 로컬 식별자",
      value: formatTokens(value), rawValue: value, share: Math.round(value / max * 100), color: (["ink", "violet", "lime", "blue"] as const)[index % 4],
      events: events.length,
      devices: new Set(events.map((event) => event.deviceId)).size,
      providers: new Set(events.map((event) => event.provider)).size,
    }));
  }, [periodEvents]);

  const deviceUsage = useMemo(() => runtime.devices.map((device) => {
    const events = periodEvents.filter((event) => event.deviceId === device.id);
    const byProvider = displayProviders.map((provider) => ({
      provider,
      value: events.filter((event) => event.provider === provider).reduce((sum, event) => sum + tokenTotal(event.tokens), 0),
    }));
    return {
      ...device,
      current: device.id === currentDeviceId,
      total: events.reduce((sum, event) => sum + tokenTotal(event.tokens), 0),
      eventCount: events.length,
      projectCount: new Set(events.map((event) => event.projectId)).size,
      byProvider,
    };
  }).sort((a, b) => b.total - a.total), [currentDeviceId, displayProviders, periodEvents, runtime.devices]);

  const sessions = useMemo(() => {
    const latest = new Map<string, UsageEvent>();
    usageEvents.forEach((event) => {
      const current = latest.get(event.sessionId);
      if (!current || event.occurredAt > current.occurredAt) latest.set(event.sessionId, event);
    });
    return [...latest.values()].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, 30).map((event) => ({
      id: event.sessionId,
      provider: event.provider,
      occurredAt: event.occurredAt,
      title: runtime.sessionTitles[event.sessionId] ?? "",
    }));
  }, [usageEvents, runtime.sessionTitles]);

  const connectedCount = Object.values(runtime.integrations).filter(Boolean).length;
  const authenticated = runtime.auth.status === "authenticated";
  const accountName = authenticated ? "동기화 계정" : "로컬 사용자";
  const accountMeta = authenticated ? "여러 기기 동기화 활성" : runtime.auth.enabled ? "로그인 필요" : "Supabase 연결 대기";
  const syncLabel = runtime.cloudSync.status === "syncing" || runtime.syncing ? "동기화 중" : runtime.cloudSync.status === "error" || runtime.error ? "수집 오류" : "실시간 수집 중";

  const runSync = () => void Promise.all([runtime.syncNow(), providerQuotas.refresh()]);
  const changeWindowMode = async (enabled: boolean) => {
    try {
      await applyWindowMode(enabled);
      setMiniMode(enabled);
      window.localStorage.setItem(MINI_MODE_KEY, String(enabled));
      setWindowModeError("");
    } catch (cause) {
      setWindowModeError(cause instanceof Error ? cause.message : "창 모드를 변경하지 못했습니다.");
    }
  };
  const toggleProvider = (provider: Provider, current: Provider[], setCurrent: (providers: Provider[]) => void, storageKey: string) => {
    const next = current.includes(provider) ? current.filter((item) => item !== provider) : ALL_PROVIDERS.filter((item) => current.includes(item) || item === provider);
    if (!next.length) return;
    setCurrent(next);
    window.localStorage.setItem(storageKey, JSON.stringify(next));
  };
  const changeMiniOpacity = (opacity: number) => {
    const next = Math.max(0, Math.min(100, opacity));
    setMiniOpacity(next);
    window.localStorage.setItem(MINI_OPACITY_KEY, String(next));
  };

  if (miniMode) return <MiniDashboard quotas={Object.values(providerQuotas.quotas)} providers={miniProviders} opacity={miniOpacity} updatedAt={providerQuotas.updatedAt} syncing={providerQuotas.loading || providerQuotas.busy} error={providerQuotas.error} onToggleProvider={(provider) => toggleProvider(provider, miniProviders, setMiniProviders, MINI_PROVIDERS_KEY)} onOpacityChange={changeMiniOpacity} onExit={() => void changeWindowMode(false)} onRefresh={runSync} />;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">대시보드 본문으로 이동</a>
      <aside className="sidebar" aria-label="앱 탐색">
        <div className="brand" aria-label="Token Deck 홈"><span className="brand-mark"><Icon name="activity" /></span><span className="brand-copy">TOKEN<small>DECK</small></span></div>
        <nav>
          <button className={`nav-item ${activeView === "overview" ? "active" : ""}`} aria-current={activeView === "overview" ? "page" : undefined} onClick={() => setActiveView("overview")}><Icon name="activity" /><span>개요</span></button>
          <button className={`nav-item ${activeView === "projects" ? "active" : ""}`} aria-current={activeView === "projects" ? "page" : undefined} onClick={() => setActiveView("projects")}><Icon name="folder" /><span>프로젝트</span></button>
          <button className={`nav-item ${activeView === "devices" ? "active" : ""}`} aria-current={activeView === "devices" ? "page" : undefined} onClick={() => setActiveView("devices")}><Icon name="device" /><span>기기</span></button>
        </nav>
        <div className="sidebar-bottom">
          <button className="nav-item" onClick={() => setSettingsOpen(true)}><Icon name="settings" /><span>설정</span></button>
          <button className="account-chip account-button" onClick={() => setSettingsOpen(true)}><span className="avatar">TD</span><div><strong>{accountName}</strong><small>{accountMeta}</small></div><Icon name="chevron" /></button>
        </div>
      </aside>

      <main id="main" className="dashboard">
        <header className="topbar">
          <div><p className="kicker">{activeView === "overview" ? "통합 사용량 관제" : activeView === "projects" ? "프로젝트 분석" : "기기 분석"}</p><h1>{activeView === "overview" ? "토큰 흐름을 확인하세요." : activeView === "projects" ? "프로젝트별 사용량" : "기기별 사용량"}</h1><p>{activeView === "overview" ? "모든 AI 코딩 도구의 실제 사용 흐름을 한눈에 확인하세요." : activeView === "projects" ? "작업한 프로젝트마다 사용한 토큰과 참여 기기를 확인하세요." : "같은 계정으로 연결된 각 기기의 토큰 사용량을 비교하세요."}</p></div>
          <div className="top-actions"><button className="mini-mode-entry" onClick={() => void changeWindowMode(true)}><Icon name="spark" /> 미니 모드</button><span className={`live-pill ${runtime.error ? "error" : ""}`}><i /> {syncLabel}</span><button className="icon-button" aria-label="지금 동기화" onClick={runSync}><Icon className={runtime.syncing ? "spin" : ""} name="refresh" /></button><button className="icon-button mobile-settings" aria-label="설정 열기" onClick={() => setSettingsOpen(true)}><Icon name="settings" /></button></div>
        </header>

        {(runtime.error || runtime.cloudSync.error || providerQuotas.error || windowModeError) && <div className="error-banner" role="alert"><Icon name="warning" /><span>{runtime.error ?? runtime.cloudSync.error ?? providerQuotas.error ?? windowModeError}</span></div>}

        <section id="overview" className="hero-grid" aria-label="사용량 요약" hidden={activeView !== "overview"}>
          <article className="total-card">
            <div className="card-topline"><span className="eyebrow">TOTAL TOKENS</span><div className="segmented" aria-label="조회 기간">{(["오늘", "7일", "30일"] as Period[]).map((item) => <button key={item} className={period === item ? "selected" : ""} aria-pressed={period === item} onClick={() => setPeriod(item)}>{item}</button>)}</div></div>
            <div className="total-number"><strong>{actualTotal.toLocaleString("ko-KR")}</strong><span>tokens</span></div>
            <div className="delta"><Icon name="activity" /> 선택 기간에 <strong>{periodEvents.length.toLocaleString("ko-KR")}개</strong> 실제 이벤트 수집</div>
            <div className="pulse-orbit" aria-hidden="true"><span /><i /><b /></div>
          </article>
          <article className="status-card">
            <span className="eyebrow">SYNC HEALTH</span><div className="health-label"><strong>{runtime.cloudSync.status === "disabled" ? "LOCAL" : runtime.cloudSync.status.toUpperCase()}</strong></div>
            <p>최근 갱신 <strong>{runtime.syncing ? "진행 중" : runtime.updatedAt ? runtime.updatedAt.toLocaleTimeString("ko-KR") : "대기 중"}</strong></p>
            <div className="status-row"><span><i className="ok" /> 현재 기기</span><strong>1</strong></div>
            <div className="status-row"><span><i className={connectedCount ? "ok" : ""} /> 수집 커넥터</span><strong>{connectedCount} / 3</strong></div>
          </article>
        </section>

        <section className="provider-section" hidden={activeView !== "overview"}>
          <SectionTitle eyebrow="PROVIDERS" title="공급사별 사용량" action={<button className="text-button" onClick={() => setSettingsOpen(true)}>연결 설정 <Icon name="chevron" /></button>} />
          <div className="provider-grid">{providers.map((provider) => (
            <article className={`provider-card ${provider.tone}`} key={provider.name}>
              <div className="provider-heading"><span className="provider-logo">{provider.monogram}</span><div><h3>{provider.name}</h3><p>{provider.model}</p></div><span className="provider-delta">{quotaStatusLabel(provider.quota)}</span></div>
              <strong className="provider-value">{provider.value}</strong><span className="provider-unit">tokens</span>
              <div className="provider-windows"><div className={remainingTone(provider.quota.fiveHour)}><span>5시간 한도 잔여</span><strong>{remainingLabel(provider.quota.fiveHour)}</strong></div><div className={remainingTone(provider.quota.weekly)}><span>주간 한도 잔여</span><strong>{remainingLabel(provider.quota.weekly)}</strong></div></div>
              <div className="meter" aria-label={`${provider.name}의 선택 기간 내 비중 ${provider.percent}%`}><i style={{ width: `${provider.percent}%` }} /></div>
              <div className="meter-label"><span>기간 내 비중</span><strong>{provider.percent}%</strong></div>
            </article>
          ))}</div>
        </section>

        <section className="content-grid" hidden={activeView !== "overview"}>
          <article className="panel trend-panel">
            <SectionTitle eyebrow="ACTIVITY" title="실제 사용량 추이" action={<div className="legend">{displayProviders.map((provider) => <span className={provider} key={provider}>{providerInfo[provider].name}</span>)}</div>} />
            <UsageChart data={chartData} />
          </article>
          <article id="projects" className="panel project-panel">
            <SectionTitle eyebrow="PROJECTS" title="프로젝트 순위" />
            {projects.length ? <ol className="project-list">{projects.map((project, index) => <li key={project.name}><span className="rank">0{index + 1}</span><div className="project-main"><div className="project-info"><span className={`project-dot ${project.color}`} /><div><strong>{project.name}</strong><small>{project.path}</small></div><b>{project.value}</b></div><div className="project-bar"><i className={project.color} style={{ width: `${project.share}%` }} /></div></div></li>)}</ol> : <div className="panel-empty"><Icon name="folder" /><strong>아직 프로젝트 사용량이 없습니다.</strong><p>지원되는 AI 도구에서 작업하면 자동으로 분류됩니다.</p></div>}
          </article>
        </section>

        <section className="lower-grid" hidden={activeView !== "overview"}>
          <article id="devices" className="panel device-panel">
            <SectionTitle eyebrow="DEVICES" title="연결된 기기" action={<span className="count-badge">{runtime.devices.length}대</span>} />
            <div className="device-list">{runtime.devices.map((device) => <div className="device-row" key={device.id}><span className={`device-icon ${device.id === currentDeviceId ? "current" : ""}`}><Icon name={"device" as IconName} /></span><div><strong>{device.name}</strong><small>{device.platform} · {new Date(device.lastSeenAt).toLocaleString("ko-KR")}</small></div><span className="device-status"><i />{device.id === currentDeviceId ? "현재 기기" : "동기화됨"}</span></div>)}</div>
          </article>
          <article className="privacy-card">
            <div className="privacy-icon"><Icon name="lock" /></div><div className="privacy-copy"><span className="eyebrow">PRIVACY GUARD</span><h2>코드는 기기 밖으로 나가지 않아요.</h2><p>토큰 수치와 익명 프로젝트 ID만 암호화해 동기화합니다.</p><div className="privacy-meta"><Icon name="check" /> 전체 경로·프롬프트 수집 안 함</div></div>
            <button className={`toggle ${privacy ? "on" : ""}`} role="switch" aria-checked={privacy} aria-label="개인정보 보호 안내 확인" onClick={() => setPrivacy(!privacy)}><span /></button>
          </article>
        </section>

        <section className="detail-view" aria-label="프로젝트별 사용량" hidden={activeView !== "projects"}>
          <article className="panel detail-panel">
            <SectionTitle eyebrow="ALL PROJECTS" title={`${projects.length}개 프로젝트`} action={<div className="segmented" aria-label="프로젝트 조회 기간">{(["오늘", "7일", "30일"] as Period[]).map((item) => <button key={item} className={period === item ? "selected" : ""} aria-pressed={period === item} onClick={() => setPeriod(item)}>{item}</button>)}</div>} />
            {projects.length ? <div className="detail-list">{projects.map((project, index) => <article className="detail-row" key={project.id}>
              <span className="detail-rank">{String(index + 1).padStart(2, "0")}</span>
              <div className="detail-main"><div className="detail-name"><span className={`project-dot ${project.color}`} /><div><strong>{project.name}</strong><small>{project.path}</small></div></div><div className="detail-meter"><i className={project.color} style={{ width: `${project.share}%` }} /></div></div>
              <div className="detail-metrics primary"><strong>{project.value}</strong><small>토큰</small></div>
              <div className="detail-metrics"><strong>{project.events.toLocaleString("ko-KR")}</strong><small>이벤트</small></div>
              <div className="detail-metrics"><strong>{project.devices}</strong><small>기기</small></div>
              <div className="detail-metrics"><strong>{project.providers}</strong><small>도구</small></div>
            </article>)}</div> : <div className="panel-empty large"><Icon name="folder" /><strong>아직 프로젝트 사용량이 없습니다.</strong><p>Codex, Claude 또는 Gemini에서 작업하면 프로젝트별로 자동 분류됩니다.</p></div>}
          </article>
        </section>

        <section className="detail-view" aria-label="기기별 사용량" hidden={activeView !== "devices"}>
          <article className="panel detail-panel">
            <SectionTitle eyebrow="ACCOUNT DEVICES" title={`${runtime.devices.length}대 기기`} action={<div className="segmented" aria-label="기기 조회 기간">{(["오늘", "7일", "30일"] as Period[]).map((item) => <button key={item} className={period === item ? "selected" : ""} aria-pressed={period === item} onClick={() => setPeriod(item)}>{item}</button>)}</div>} />
            <div className="device-usage-grid">{deviceUsage.map((device) => <article className="device-usage-card" key={device.id}>
              <div className="device-usage-head"><span className={`device-icon ${device.current ? "current" : ""}`}><Icon name="device" /></span><div><strong>{device.name}</strong><small>{device.platform} · 최근 연결 {new Date(device.lastSeenAt).toLocaleString("ko-KR")}</small></div><span className="device-status"><i />{device.current ? "현재 기기" : "동기화됨"}</span></div>
              <div className="device-total"><strong>{device.total.toLocaleString("ko-KR")}</strong><span>tokens</span></div>
              <div className="device-provider-list">{device.byProvider.map((item) => <div key={item.provider}><span>{providerInfo[item.provider].name}</span><strong>{formatTokens(item.value)}</strong></div>)}</div>
              <div className="device-foot"><span>{device.projectCount}개 프로젝트</span><span>{device.eventCount.toLocaleString("ko-KR")}개 이벤트</span></div>
            </article>)}</div>
          </article>
        </section>

        <footer><span>Token Deck <b>v0.2.0</b></span><span><i /> {usageEvents.length ? "실제 사용량 연결됨" : "수집 이벤트 대기 중"}</span><span>마지막 갱신 · {runtime.syncing ? "동기화 중" : runtime.updatedAt?.toLocaleTimeString("ko-KR") ?? "대기 중"}</span></footer>
      </main>

      <SettingsPanel
        open={settingsOpen}
        auth={runtime.auth}
        cloudSync={runtime.cloudSync}
        credentials={runtime.credentials}
        gemini={nativeSettings.gemini}
        autostart={nativeSettings.autostart}
        nativeBusy={nativeSettings.busy}
        nativeMessage={nativeSettings.message}
        providerUsage={runtime.providerUsage}
        sessions={sessions}
        displayProviders={displayProviders}
        claudeQuotaCapture={providerQuotas.claudeCapture}
        quotaBusy={providerQuotas.busy}
        onClose={() => setSettingsOpen(false)}
        onConfigureSupabase={(url, anonKey) => runtime.configureSupabase(url, anonKey)}
        onClearSupabaseConfig={() => runtime.clearSupabaseConfig()}
        onSendMagicLink={(email) => runtime.sendMagicLink(email)}
        onSignOut={() => runtime.signOut()}
        onSaveCredential={(provider, credentials) => runtime.saveProviderCredential(provider, credentials)}
        onRemoveCredential={(provider) => runtime.removeProviderCredential(provider)}
        onRefreshProvider={(provider) => runtime.refreshProviderUsage(provider)}
        onUpdateSessionTitle={(sessionId, title) => runtime.updateSessionTitle(sessionId, title)}
        onSetAutostart={(enabled) => nativeSettings.toggleAutostart(enabled)}
        onConfigureGemini={() => nativeSettings.enableGeminiTelemetry()}
        onToggleDisplayProvider={(provider) => toggleProvider(provider, displayProviders, setDisplayProviders, DISPLAY_PROVIDERS_KEY)}
        onConfigureClaudeQuota={() => providerQuotas.enableClaudeCapture()}
      />
    </div>
  );
}

function readProviderList(key: string, fallback: Provider[]): Provider[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "") as unknown;
    if (Array.isArray(parsed)) {
      const providers = ALL_PROVIDERS.filter((provider) => parsed.includes(provider));
      if (providers.length) return providers;
    }
  } catch {
    if (key === MINI_PROVIDERS_KEY) {
      const legacy = window.localStorage.getItem("token-deck-mini-selection");
      if (legacy === "codex_claude") return ["codex", "claude"];
      if (legacy === "codex" || legacy === "claude" || legacy === "gemini") return [legacy];
    }
  }
  return fallback;
}

function readOpacity(): number {
  const value = Number(window.localStorage.getItem(MINI_OPACITY_KEY) ?? "90");
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 90;
}
