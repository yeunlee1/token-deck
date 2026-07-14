// AI 도구별 실제 토큰 사용량과 계정 연결 상태를 통합해 보여주는 데스크톱 대시보드
import { useEffect, useMemo, useRef, useState } from "react";
import { buildUsageChart, type ChartPeriod } from "./components/chart-data";
import { selectProjectDeviceEvents } from "./components/dashboard-usage";
import { DeviceInventoryPanel } from "./components/DeviceInventoryPanel";
import { Icon, type IconName } from "./components/Icon";
import { MiniDashboard } from "./components/MiniDashboard";
import { OnboardingScreen } from "./components/OnboardingScreen";
import { ONBOARDING_COMPLETE_KEY, prepareLoginScreen } from "./components/onboarding-state";
import { ProjectNameEditor } from "./components/ProjectNameEditor";
import { SettingsPanel } from "./components/SettingsPanel";
import { UsageChart } from "./components/UsageChart";
import { quotaStatusLabel, quotaWindowLabel, remainingTone } from "./components/quota-display";
import { tokenTotal, type Provider, type UsageEvent } from "./core";
import { buildAccountUsageMatrix } from "./core/account-usage";
import { useAutoUpdater } from "./hooks/useAutoUpdater";
import { useAppRuntime } from "./hooks/useAppRuntime";
import { getOrCreateDeviceId } from "./hooks/useLocalUsage";
import { useNativeSettings } from "./hooks/useNativeSettings";
import { useProviderQuotas } from "./hooks/useProviderQuotas";
import { setCollectionProviders } from "./platform/tauri";
import { applyWindowMode, setWindowPinned } from "./platform/window-mode";
import { applyTheme, readTheme, storeTheme, type ThemeId } from "./theme";
import "./styles.css";

type Period = ChartPeriod;
type ActiveView = "overview" | "projects" | "devices";
const MINI_MODE_KEY = "token-deck-mini-mode";
const MINI_PROVIDERS_KEY = "token-deck-mini-providers";
const MINI_PINNED_KEY = "token-deck-mini-pinned";
const MINI_TOTAL_VISIBLE_KEY = "token-deck-mini-total-visible";
const DASHBOARD_PERIOD_KEY = "token-deck-dashboard-period";
const COLLECTION_PROVIDERS_KEY = "token-deck-collection-providers";
const ALL_PROVIDERS: Provider[] = ["codex", "claude", "gemini"];
const EMPTY_DEVICE_INVENTORY = { schemaVersion: 1 as const, capturedAt: 0, items: [], warnings: [] };

const providerInfo = {
  codex: { name: "OpenAI Codex", model: "Codex 앱 + CLI", tone: "ink", monogram: "CX" },
  claude: { name: "Claude", model: "Claude Code", tone: "lime", monogram: "CL" },
  gemini: { name: "Gemini", model: "Gemini CLI", tone: "violet", monogram: "GM" },
} as const;

function formatTokens(value: number): string {
  return new Intl.NumberFormat("ko-KR", { notation: value > 9999 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function formatTimestamp(value?: string | number): string {
  if (value === undefined) return "기록 없음";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "기록 없음" : date.toLocaleString("ko-KR");
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

export function LoginScreenEntry({ authenticated, onReturnToLogin }: { authenticated: boolean; onReturnToLogin: () => Promise<void> | void }) {
  if (authenticated) return null;

  return <button type="button" className="nav-item login-screen-entry" aria-label="로그인 화면으로 돌아가기" onClick={() => void onReturnToLogin()}><Icon name="cloud" /><span>로그인 화면으로 돌아가기</span></button>;
}

export function dashboardConnectionLabels(
  onboardingComplete: boolean,
  authStatus: "local" | "signed_out" | "authenticated",
  authEnabled: boolean,
  cloudSyncStatus: string,
): { accountMeta: string; syncHealth: string } {
  const authenticated = authStatus === "authenticated";
  const localOnly = onboardingComplete && !authenticated;
  return {
    accountMeta: authenticated ? "여러 기기 동기화 활성" : localOnly ? "로컬 전용 사용 중" : authEnabled ? "로그인 필요" : "운영 서버 연결 오류",
    syncHealth: localOnly || cloudSyncStatus === "disabled" ? "LOCAL" : cloudSyncStatus.toUpperCase(),
  };
}

export default function App() {
  useAutoUpdater();
  const [enabledProviders, setEnabledProviders] = useState<Provider[]>(() => readProviderList(COLLECTION_PROVIDERS_KEY, ALL_PROVIDERS));
  const runtime = useAppRuntime(enabledProviders);
  const nativeSettings = useNativeSettings(enabledProviders.includes("gemini"));
  const providerQuotas = useProviderQuotas(enabledProviders);
  const [currentDeviceId] = useState(() => getOrCreateDeviceId());
  const [period, setPeriod] = useState<Period>(() => readPeriod());
  const [activeView, setActiveView] = useState<ActiveView>("overview");
  const [miniMode, setMiniMode] = useState(() => window.localStorage.getItem(ONBOARDING_COMPLETE_KEY) === "true" && window.localStorage.getItem(MINI_MODE_KEY) === "true");
  const [miniProviders, setMiniProviders] = useState<Provider[]>(() => readProviderList(MINI_PROVIDERS_KEY, ["codex", "claude"]));
  const [miniPinned, setMiniPinned] = useState(() => window.localStorage.getItem(MINI_PINNED_KEY) === "true");
  const [miniTotalVisible, setMiniTotalVisible] = useState(() => window.localStorage.getItem(MINI_TOTAL_VISIBLE_KEY) !== "false");
  const [onboardingComplete, setOnboardingComplete] = useState(() => window.localStorage.getItem(ONBOARDING_COMPLETE_KEY) === "true");
  const [editingProjectId, setEditingProjectId] = useState<string>();
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const [projectNameError, setProjectNameError] = useState("");
  const [inventoryChoiceError, setInventoryChoiceError] = useState("");
  const [inventoryChoiceBusy, setInventoryChoiceBusy] = useState(false);
  const [windowModeError, setWindowModeError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeId>(() => readTheme());
  const collectionProvidersRef = useRef(enabledProviders);
  const collectionPolicyWrites = useRef<Promise<void>>(Promise.resolve());
  const usageEvents = runtime.combinedEvents;
  const visibleEvents = useMemo(() => usageEvents.filter((event) => enabledProviders.includes(event.provider)), [enabledProviders, usageEvents]);
  const periodEvents = useMemo(() => usageInPeriod(visibleEvents, period), [visibleEvents, period]);
  const projectDeviceEvents = useMemo(() => selectProjectDeviceEvents(runtime.localSessionEvents, enabledProviders, periodStart(period)), [enabledProviders, period, runtime.localSessionEvents]);
  const accountUsage = useMemo(() => buildAccountUsageMatrix(projectDeviceEvents), [projectDeviceEvents]);
  const actualTotal = accountUsage.totals.totalTokens;
  const miniTotal = useMemo(() => usageInPeriod(usageEvents.filter((event) => miniProviders.includes(event.provider)), period).reduce((sum, event) => sum + tokenTotal(event.tokens), 0), [miniProviders, period, usageEvents]);
  const chartData = useMemo(() => buildUsageChart(visibleEvents, period), [visibleEvents, period]);

  const writeCollectionPolicy = (providers: Provider[]): Promise<void> => {
    const task = collectionPolicyWrites.current.catch(() => undefined).then(() => setCollectionProviders(providers));
    collectionPolicyWrites.current = task.catch(() => undefined);
    return task;
  };

  useEffect(() => {
    void writeCollectionPolicy(enabledProviders).catch((cause) => {
      setWindowModeError(cause instanceof Error ? cause.message : "수집 서비스 설정을 네이티브 수집기에 전달하지 못했습니다.");
    });
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;
    const close = (event: KeyboardEvent) => event.key === "Escape" && setSettingsOpen(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [settingsOpen]);

  useEffect(() => {
    setEditingProjectId(undefined);
    setProjectNameDraft("");
    setProjectNameError("");
  }, [runtime.auth.status, runtime.auth.userId]);

  useEffect(() => {
    setMiniProviders((current) => {
      const available = current.filter((provider) => enabledProviders.includes(provider));
      const next = available.length ? available : [enabledProviders[0]];
      if (next.length === current.length && next.every((provider, index) => provider === current[index])) return current;
      window.localStorage.setItem(MINI_PROVIDERS_KEY, JSON.stringify(next));
      return next;
    });
  }, [enabledProviders]);

  useEffect(() => {
    window.localStorage.setItem(DASHBOARD_PERIOD_KEY, period);
  }, [period]);

  useEffect(() => {
    applyTheme(theme);
    storeTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (runtime.auth.status !== "authenticated" || onboardingComplete) return;
    window.localStorage.setItem(ONBOARDING_COMPLETE_KEY, "true");
    setOnboardingComplete(true);
  }, [onboardingComplete, runtime.auth.status]);

  useEffect(() => {
    if (!miniMode) return;
    void applyWindowMode(true, miniPinned).catch((cause) => {
      setMiniMode(false);
      window.localStorage.removeItem(MINI_MODE_KEY);
      setWindowModeError(cause instanceof Error ? cause.message : "미니 창으로 전환하지 못했습니다.");
    });
  }, []);

  const providers = useMemo(() => {
    const totals = enabledProviders.map((provider) => ({
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
  }, [actualTotal, enabledProviders, periodEvents, providerQuotas.quotas, runtime.integrations]);

  const projects = useMemo(() => {
    const max = Math.max(...accountUsage.projects.map((project) => project.totals.totalTokens), 1);
    return accountUsage.projects.map((project, index) => ({
      id: project.projectId,
      name: runtime.projectNames[project.projectId] ?? `프로젝트 ${project.projectId.slice(-6).toUpperCase()}`,
      source: runtime.projectNameOverrides[project.projectId] || runtime.remoteProjectNames[project.projectId] ? "계정에 저장된 이름" : project.projectId.startsWith("git_") ? "Git 저장소 이름" : "프로젝트 폴더 이름",
      value: formatTokens(project.totals.totalTokens), rawValue: project.totals.totalTokens, share: Math.round(project.totals.totalTokens / max * 100), color: (["ink", "violet", "lime", "blue"] as const)[index % 4],
      events: project.totals.requestCount,
      devices: project.devices.length,
      providers: project.totals.providerCount,
      deviceBreakdown: project.devices.map((cell) => {
        const device = runtime.devices.find((candidate) => candidate.id === cell.deviceId);
        return {
          ...cell,
          name: device?.name ?? `기기 ${cell.deviceId.slice(-6).toUpperCase()}`,
          current: cell.deviceId === currentDeviceId,
        };
      }),
    }));
  }, [accountUsage.projects, currentDeviceId, runtime.devices, runtime.projectNameOverrides, runtime.projectNames, runtime.remoteProjectNames]);

  const deviceUsage = useMemo(() => {
    const deviceById = new Map(runtime.devices.map((device) => [device.id, device]));
    const ids = new Set([...runtime.devices.map((device) => device.id), ...accountUsage.devices.map((device) => device.deviceId)]);
    return [...ids].map((deviceId) => {
      const registered = deviceById.get(deviceId);
      const aggregate = accountUsage.devices.find((device) => device.deviceId === deviceId);
      const snapshot = runtime.deviceInventories
        .filter((item) => item.deviceId === deviceId)
        .sort((left, right) => (right.updatedAt ?? right.capturedAt) - (left.updatedAt ?? left.capturedAt))[0];
      const deviceEvents = projectDeviceEvents.filter((event) => event.deviceId === deviceId);
      return {
        id: deviceId,
        name: registered?.name ?? `기기 ${deviceId.slice(-6).toUpperCase()}`,
        platform: registered?.platform ?? "windows",
        appVersion: registered?.appVersion ?? "확인 불가",
        lastSeenAt: registered?.lastSeenAt,
        current: deviceId === currentDeviceId,
        total: aggregate?.totals.totalTokens ?? 0,
        eventCount: aggregate?.totals.requestCount ?? 0,
        projectCount: aggregate?.projects.length ?? 0,
        byProvider: enabledProviders.map((provider) => ({ provider, value: aggregate?.totals.byProvider[provider].totalTokens ?? 0 })),
        projects: aggregate?.projects.map((project) => ({
          ...project,
          name: runtime.projectNames[project.projectId] ?? `프로젝트 ${project.projectId.slice(-6).toUpperCase()}`,
        })) ?? [],
        lastUsageAt: deviceEvents.reduce<string | undefined>((latest, event) => !latest || event.occurredAt > latest ? event.occurredAt : latest, undefined),
        inventoryCount: deviceId === currentDeviceId ? runtime.localInventory?.items.length ?? 0 : snapshot?.items.length ?? 0,
        inventoryCapturedAt: deviceId === currentDeviceId ? runtime.localInventory?.capturedAt : snapshot?.capturedAt,
      };
    }).sort((left, right) => Number(right.current) - Number(left.current) || right.total - left.total || left.name.localeCompare(right.name, "ko"));
  }, [accountUsage.devices, currentDeviceId, enabledProviders, projectDeviceEvents, runtime.deviceInventories, runtime.devices, runtime.localInventory, runtime.projectNames]);

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

  const connectedCount = enabledProviders.filter((provider) => runtime.integrations[provider]).length;
  const authenticated = runtime.auth.status === "authenticated";
  const connectionLabels = dashboardConnectionLabels(onboardingComplete, runtime.auth.status, runtime.auth.enabled, runtime.cloudSync.status);
  const accountName = authenticated ? "동기화 계정" : "로컬 사용자";
  const accountMeta = connectionLabels.accountMeta;
  const syncLabel = runtime.cloudSync.status === "syncing" || runtime.syncing ? "동기화 중" : runtime.cloudSync.status === "error" || runtime.error ? "수집 오류" : "실시간 수집 중";

  const runSync = () => void Promise.all([runtime.syncNow(), providerQuotas.refresh()]);
  const chooseInventorySync = async (enabled: boolean) => {
    setInventoryChoiceBusy(true);
    setInventoryChoiceError("");
    try {
      await runtime.setInventorySyncEnabled(enabled);
    } catch (cause) {
      setInventoryChoiceError(cause instanceof Error ? cause.message : "기기 도구 목록 공유 설정을 저장하지 못했습니다.");
    } finally {
      setInventoryChoiceBusy(false);
    }
  };
  const changeWindowMode = async (enabled: boolean) => {
    try {
      await applyWindowMode(enabled, enabled && miniPinned);
      setMiniMode(enabled);
      window.localStorage.setItem(MINI_MODE_KEY, String(enabled));
      setWindowModeError("");
    } catch (cause) {
      setWindowModeError(cause instanceof Error ? cause.message : "창 모드를 변경하지 못했습니다.");
    }
  };
  const toggleProvider = (provider: Provider, current: Provider[], setCurrent: (providers: Provider[]) => void, storageKey: string) => {
    const next = toggledProviderList(provider, current);
    if (!next.length) return;
    setCurrent(next);
    window.localStorage.setItem(storageKey, JSON.stringify(next));
  };
  const updateCollectionProvider = async (provider: Provider) => {
    const task = collectionPolicyWrites.current.catch(() => undefined).then(async () => {
      const next = toggledProviderList(provider, collectionProvidersRef.current);
      if (!next.length) return;
      await setCollectionProviders(next);
      collectionProvidersRef.current = next;
      setEnabledProviders(next);
      window.localStorage.setItem(COLLECTION_PROVIDERS_KEY, JSON.stringify(next));
    });
    collectionPolicyWrites.current = task.catch(() => undefined);
    try {
      await task;
      setWindowModeError("");
    } catch (cause) {
      setWindowModeError(cause instanceof Error ? cause.message : "수집 서비스 설정을 저장하지 못했습니다.");
    }
  };
  const toggleMiniPinned = async () => {
    const next = !miniPinned;
    try {
      await setWindowPinned(next);
      setMiniPinned(next);
      window.localStorage.setItem(MINI_PINNED_KEY, String(next));
      setWindowModeError("");
    } catch (cause) {
      setWindowModeError(cause instanceof Error ? cause.message : "창 고정 상태를 바꾸지 못했습니다.");
    }
  };
  const toggleMiniTotal = () => {
    const next = !miniTotalVisible;
    setMiniTotalVisible(next);
    window.localStorage.setItem(MINI_TOTAL_VISIBLE_KEY, String(next));
  };
  const continueLocally = () => {
    runtime.cancelPendingAuth();
    window.localStorage.setItem(ONBOARDING_COMPLETE_KEY, "true");
    setOnboardingComplete(true);
  };
  const returnToLogin = async () => {
    setEditingProjectId(undefined);
    setProjectNameDraft("");
    setProjectNameError("");
    await prepareLoginScreen(runtime.auth.status, runtime.signOut, window.localStorage);
    setSettingsOpen(false);
    setOnboardingComplete(false);
  };
  const startProjectNameEdit = (id: string, name: string) => { setEditingProjectId(id); setProjectNameDraft(name); };
  const cancelProjectNameEdit = () => { setEditingProjectId(undefined); setProjectNameDraft(""); };
  const saveProjectName = async (id: string) => {
    try {
      await runtime.updateProjectName(id, projectNameDraft);
      setProjectNameError("");
      cancelProjectNameEdit();
    } catch (cause) {
      setProjectNameError(cause instanceof Error ? cause.message : "프로젝트 이름을 저장하지 못했습니다.");
    }
  };

  if (!onboardingComplete && runtime.auth.status !== "authenticated") return <OnboardingScreen authEnabled={runtime.auth.enabled} authError={runtime.auth.error} onSignInWithGoogle={() => runtime.signInWithGoogle()} onSendMagicLink={(email) => runtime.sendMagicLink(email)} onContinueLocal={continueLocally} />;

  if (miniMode) return <MiniDashboard quotas={Object.values(providerQuotas.quotas)} providers={miniProviders} availableProviders={enabledProviders} showTotal={miniTotalVisible} totalTokens={miniTotal} totalPeriod={period} updatedAt={providerQuotas.updatedAt} syncing={providerQuotas.loading || providerQuotas.busy} error={providerQuotas.error} pinned={miniPinned} onToggleProvider={(provider) => toggleProvider(provider, miniProviders, setMiniProviders, MINI_PROVIDERS_KEY)} onTogglePinned={() => void toggleMiniPinned()} onExit={() => void changeWindowMode(false)} />;

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
          <LoginScreenEntry authenticated={authenticated} onReturnToLogin={returnToLogin} />
          <button className="nav-item" onClick={() => setSettingsOpen(true)}><Icon name="settings" /><span>설정</span></button>
          <button className="account-chip account-button" onClick={() => setSettingsOpen(true)}><span className="avatar">TD</span><div><strong>{accountName}</strong><small>{accountMeta}</small></div><Icon name="chevron" /></button>
        </div>
      </aside>

      <main id="main" className="dashboard">
        <header className="topbar">
          <div><p className="kicker">{activeView === "overview" ? "통합 사용량 관제" : activeView === "projects" ? "프로젝트 분석" : "기기 분석"}</p><h1>{activeView === "overview" ? "토큰 흐름을 확인하세요." : activeView === "projects" ? "프로젝트별 사용량" : "기기별 사용량과 설정"}</h1><p>{activeView === "overview" ? "같은 계정에 등록된 모든 기기의 실제 사용 흐름을 한눈에 확인하세요." : activeView === "projects" ? "각 프로젝트의 계정 총량과 기기별 사용량을 함께 확인하세요." : "같은 계정의 기기별 프로젝트 토큰과 스킬·MCP·플러그인 차이를 비교하세요."}</p></div>
          <div className="top-actions"><button className="mini-mode-entry" onClick={() => void changeWindowMode(true)}><Icon name="spark" /> 미니 모드</button><span className={`live-pill ${runtime.error ? "error" : ""}`}><i /> {syncLabel}</span><button className="icon-button" aria-label="지금 동기화" onClick={runSync}><Icon className={runtime.syncing ? "spin" : ""} name="refresh" /></button><button className="icon-button mobile-settings" aria-label="설정 열기" onClick={() => setSettingsOpen(true)}><Icon name="settings" /></button></div>
        </header>

        {(runtime.error || runtime.cloudSync.error || providerQuotas.error || windowModeError || projectNameError || inventoryChoiceError) && <div className="error-banner" role="alert"><Icon name="warning" /><span>{runtime.error || runtime.cloudSync.error || providerQuotas.error || windowModeError || projectNameError || inventoryChoiceError}</span></div>}

        {authenticated && !runtime.inventorySyncPreferenceSet && <section className="inventory-choice-banner" aria-labelledby="inventory-choice-title"><Icon name="device" /><div><strong id="inventory-choice-title">이 기기의 도구 목록을 추가로 공유할까요?</strong><p>켜면 목록 시각·비교 해시와 스킬·MCP·플러그인의 공급사·종류·ID·이름·버전, 설치·활성 상태, 출처·마켓플레이스, MCP 연결 방식, 비밀 설정 필요 여부와 가져오기 가능 여부·제한 사유 분류를 추가 저장합니다. 코드, 프롬프트·응답, 전체 경로, Git 원격 주소 원문, 스킬 본문, MCP 명령·인수·URL, 환경변수, API 키·OAuth 토큰과 비밀값은 전송하지 않습니다. 공유하지 않아도 사용량·프로젝트·기기 동기화는 계속됩니다.</p></div><div><button className="primary-button" type="button" disabled={inventoryChoiceBusy} onClick={() => void chooseInventorySync(true)}>목록 공유 켜기</button><button className="secondary-button" type="button" disabled={inventoryChoiceBusy} onClick={() => void chooseInventorySync(false)}>공유 안 함</button></div></section>}

        <section id="overview" className="hero-grid" aria-label="사용량 요약" hidden={activeView !== "overview"}>
          <article className="total-card">
            <div className="card-topline"><span className="eyebrow">ACCOUNT TOTAL TOKENS</span><div className="segmented" aria-label="조회 기간">{(["오늘", "7일", "30일"] as Period[]).map((item) => <button key={item} className={period === item ? "selected" : ""} aria-pressed={period === item} onClick={() => setPeriod(item)}>{item}</button>)}</div></div>
            <div className="total-number"><strong>{actualTotal.toLocaleString("ko-KR")}</strong><span>tokens</span></div>
            <div className="delta"><Icon name="activity" /> 등록 기기 {runtime.devices.length}대에서 <strong>{accountUsage.totals.requestCount.toLocaleString("ko-KR")}개</strong> 실제 이벤트 합산</div>
            <div className="pulse-orbit" aria-hidden="true"><span /><i /><b /></div>
          </article>
          <article className="status-card">
            <span className="eyebrow">SYNC HEALTH</span><div className="health-label"><strong>{connectionLabels.syncHealth}</strong></div>
            <p>최근 갱신 <strong>{runtime.syncing ? "진행 중" : runtime.updatedAt ? runtime.updatedAt.toLocaleTimeString("ko-KR") : "대기 중"}</strong></p>
            <div className="status-row"><span><i className="ok" /> 등록 기기</span><strong>{runtime.devices.length}</strong></div>
            <div className="status-row"><span><i className={connectedCount ? "ok" : ""} /> 수집 커넥터</span><strong>{connectedCount} / {enabledProviders.length}</strong></div>
          </article>
        </section>

        <section className="provider-section" hidden={activeView !== "overview"}>
          <SectionTitle eyebrow="PROVIDERS" title="공급사별 사용량" action={<button className="text-button" onClick={() => setSettingsOpen(true)}>연결 설정 <Icon name="chevron" /></button>} />
          <div className="provider-grid">{providers.map((provider) => (
            <article className={`provider-card ${provider.tone}`} key={provider.name}>
              <div className="provider-heading"><span className="provider-logo">{provider.monogram}</span><div><h3>{provider.name}</h3><p>{provider.model}</p></div><span className="provider-delta">{quotaStatusLabel(provider.quota)}</span></div>
              <strong className="provider-value">{provider.value}</strong><span className="provider-unit">tokens</span>
              <div className="provider-windows"><div className={remainingTone(provider.quota.fiveHour)}><span>5시간 한도 잔여</span><strong>{quotaWindowLabel(provider.quota, "fiveHour")}</strong></div><div className={remainingTone(provider.quota.weekly)}><span>주간 한도 잔여</span><strong>{quotaWindowLabel(provider.quota, "weekly")}</strong></div></div>
              <div className="meter" aria-label={`${provider.name}의 선택 기간 내 비중 ${provider.percent}%`}><i style={{ width: `${provider.percent}%` }} /></div>
              <div className="meter-label"><span>기간 내 비중</span><strong>{provider.percent}%</strong></div>
            </article>
          ))}</div>
        </section>

        <section className="content-grid" hidden={activeView !== "overview"}>
          <article className="panel trend-panel">
            <SectionTitle eyebrow="ACTIVITY" title="실제 사용량 추이" action={<div className="legend">{enabledProviders.map((provider) => <span className={provider} key={provider}>{providerInfo[provider].name}</span>)}</div>} />
            <UsageChart data={chartData} />
          </article>
          <article id="projects" className="panel project-panel">
            <SectionTitle eyebrow="PROJECTS" title="프로젝트 순위" />
            {projects.length ? <ol className="project-list">{projects.map((project, index) => <li key={project.id}><span className="rank">0{index + 1}</span><div className="project-main"><div className="project-info"><span className={`project-dot ${project.color}`} /><ProjectNameEditor name={project.name} source={project.source} editing={editingProjectId === project.id} draft={projectNameDraft} onStart={() => startProjectNameEdit(project.id, project.name)} onDraftChange={setProjectNameDraft} onSave={() => void saveProjectName(project.id)} onCancel={cancelProjectNameEdit} /><b>{project.value}</b></div><div className="project-bar"><i className={project.color} style={{ width: `${project.share}%` }} /></div></div></li>)}</ol> : <div className="panel-empty"><Icon name="folder" /><strong>아직 프로젝트 사용량이 없습니다.</strong><p>지원되는 AI 도구에서 작업하면 자동으로 분류됩니다.</p></div>}
          </article>
        </section>

        <section className="lower-grid" hidden={activeView !== "overview"}>
          <article id="devices" className="panel device-panel">
            <SectionTitle eyebrow="DEVICES" title="연결된 기기" action={<span className="count-badge">{runtime.devices.length}대</span>} />
            <div className="device-list">{runtime.devices.map((device) => <div className="device-row" key={device.id}><span className={`device-icon ${device.id === currentDeviceId ? "current" : ""}`}><Icon name={"device" as IconName} /></span><div><strong>{device.name}</strong><small>{device.platform} · v{device.appVersion} · ID {device.id.slice(-6).toUpperCase()} · {new Date(device.lastSeenAt).toLocaleString("ko-KR")}</small></div><span className="device-status"><i />{device.id === currentDeviceId ? "현재 기기" : "동기화됨"}</span></div>)}</div>
          </article>
          <article className="privacy-card">
            <div className="privacy-icon"><Icon name="lock" /></div><div className="privacy-copy"><span className="eyebrow">PRIVACY GUARD</span><h2>코드는 기기 밖으로 나가지 않아요.</h2><p>로그인하면 AI 도구·모델, 토큰 수치·사용 시각, 익명 프로젝트·세션·기기 ID, 표시용 이름과 기기 상태를 동기화합니다. 도구 목록 공유를 켠 기기는 스킬·MCP·플러그인의 비교용 메타데이터도 저장합니다.</p><div className="privacy-meta"><Icon name="check" /> 코드·프롬프트·응답·전체 경로·Git 원격 원문·스킬 본문·MCP 명령·인수·URL·환경변수·API 키·OAuth 토큰 수집 안 함</div></div>
          </article>
        </section>

        <section className="detail-view" aria-label="프로젝트별 사용량" hidden={activeView !== "projects"}>
          <article className="panel detail-panel">
            <SectionTitle eyebrow="ALL PROJECTS" title={`${projects.length}개 프로젝트`} action={<div className="segmented" aria-label="프로젝트 조회 기간">{(["오늘", "7일", "30일"] as Period[]).map((item) => <button key={item} className={period === item ? "selected" : ""} aria-pressed={period === item} onClick={() => setPeriod(item)}>{item}</button>)}</div>} />
            {projects.length ? <div className="detail-list">{projects.map((project, index) => <article className="project-detail-entry" key={project.id}>
              <div className="detail-row">
                <span className="detail-rank">{String(index + 1).padStart(2, "0")}</span>
                <div className="detail-main"><div className="detail-name"><span className={`project-dot ${project.color}`} /><ProjectNameEditor name={project.name} source={project.source} editing={editingProjectId === project.id} draft={projectNameDraft} onStart={() => startProjectNameEdit(project.id, project.name)} onDraftChange={setProjectNameDraft} onSave={() => void saveProjectName(project.id)} onCancel={cancelProjectNameEdit} /></div><div className="detail-meter"><i className={project.color} style={{ width: `${project.share}%` }} /></div></div>
                <div className="detail-metrics primary"><strong>{project.value}</strong><small>계정 총 토큰</small></div>
                <div className="detail-metrics"><strong>{project.events.toLocaleString("ko-KR")}</strong><small>이벤트</small></div>
                <div className="detail-metrics"><strong>{project.devices}</strong><small>기기</small></div>
                <div className="detail-metrics"><strong>{project.providers}</strong><small>도구</small></div>
              </div>
              <div className="project-device-breakdown" aria-label={`${project.name} 기기별 사용량`}>
                <div className="cross-breakdown-head"><span>기기별 사용량</span><small>합계 {project.rawValue.toLocaleString("ko-KR")} tokens</small></div>
                {project.deviceBreakdown.map((device) => <div className="project-device-line" key={device.deviceId}>
                  <span className={`device-icon ${device.current ? "current" : ""}`}><Icon name="device" /></span>
                  <div className="cross-device-copy"><strong>{device.name}</strong><small>ID {device.deviceId.slice(-6).toUpperCase()}{device.current ? " · 현재 기기" : ""}</small></div>
                  <div className="cross-provider-values">{enabledProviders.filter((provider) => device.byProvider[provider].requestCount > 0).map((provider) => <span key={provider}>{providerInfo[provider].name} <b>{formatTokens(device.byProvider[provider].totalTokens)}</b></span>)}</div>
                  <strong className="cross-total">{device.totalTokens.toLocaleString("ko-KR")}</strong>
                </div>)}
              </div>
            </article>)}</div> : <div className="panel-empty large"><Icon name="folder" /><strong>아직 프로젝트 사용량이 없습니다.</strong><p>Codex, Claude 또는 Gemini에서 작업하면 프로젝트별로 자동 분류됩니다.</p></div>}
          </article>
        </section>

        <section className="detail-view" aria-label="기기별 사용량" hidden={activeView !== "devices"}>
          <article className="panel detail-panel">
            <SectionTitle eyebrow="ACCOUNT DEVICES" title={`${runtime.devices.length}대 기기`} action={<div className="segmented" aria-label="기기 조회 기간">{(["오늘", "7일", "30일"] as Period[]).map((item) => <button key={item} className={period === item ? "selected" : ""} aria-pressed={period === item} onClick={() => setPeriod(item)}>{item}</button>)}</div>} />
            <div className="device-usage-grid">{deviceUsage.map((device) => <article className="device-usage-card" key={device.id}>
              <div className="device-usage-head"><span className={`device-icon ${device.current ? "current" : ""}`}><Icon name="device" /></span><div><strong>{device.name}</strong><small>{device.platform} · 앱 {device.appVersion} · ID {device.id.slice(-6).toUpperCase()}</small></div><span className="device-status"><i />{device.current ? "현재 기기" : "등록됨"}</span></div>
              <div className="device-total"><strong>{device.total.toLocaleString("ko-KR")}</strong><span>tokens</span></div>
              <div className="device-provider-list">{device.byProvider.map((item) => <div key={item.provider}><span>{providerInfo[item.provider].name}</span><strong>{formatTokens(item.value)}</strong></div>)}</div>
              <div className="device-sync-facts"><div><span>최근 연결</span><strong>{formatTimestamp(device.lastSeenAt)}</strong></div><div><span>최근 토큰</span><strong>{formatTimestamp(device.lastUsageAt)}</strong></div><div><span>전역 도구 목록</span><strong>{device.inventoryCount}개 · {formatTimestamp(device.inventoryCapturedAt)}</strong></div></div>
              <div className="device-project-breakdown">
                <div className="cross-breakdown-head"><span>이 기기의 프로젝트별 사용량</span><small>{device.projectCount}개 프로젝트</small></div>
                {device.projects.length ? device.projects.map((project) => <div className="device-project-line" key={project.projectId}>
                  <span className="project-dot ink" />
                  <div><strong>{project.name}</strong><small>{enabledProviders.filter((provider) => project.byProvider[provider].requestCount > 0).map((provider) => `${providerInfo[provider].name} ${formatTokens(project.byProvider[provider].totalTokens)}`).join(" · ")}</small></div>
                  <b>{project.totalTokens.toLocaleString("ko-KR")}</b>
                </div>) : <p className="cross-empty">선택 기간에 이 기기의 프로젝트 사용량이 없습니다.</p>}
              </div>
              <div className="device-foot"><span>{device.eventCount.toLocaleString("ko-KR")}개 이벤트</span><span>계정 전체에서 자동 합산</span></div>
            </article>)}</div>
          </article>
          <DeviceInventoryPanel
            devices={runtime.devices}
            currentDeviceId={currentDeviceId}
            snapshots={runtime.deviceInventories}
            localInventory={runtime.localInventory ?? EMPTY_DEVICE_INVENTORY}
            syncEnabled={runtime.inventorySyncEnabled}
            loading={runtime.inventorySync.loading}
            error={runtime.inventorySync.error}
            onEnableSync={() => runtime.setInventorySyncEnabled(true)}
            onRefresh={async () => { if (runtime.auth.status === "authenticated") await runtime.refreshAndSyncDeviceInventory(); else await runtime.refreshDeviceInventory(); }}
            onApply={(sourceDeviceId, items) => runtime.applyDeviceInventoryItems(sourceDeviceId, items)}
          />
        </section>

        <footer><span>Token Deck <b>v0.5.4</b></span><span><i /> {usageEvents.length ? "실제 사용량 연결됨" : "수집 이벤트 대기 중"}</span><span>마지막 갱신 · {runtime.syncing ? "동기화 중" : runtime.updatedAt?.toLocaleTimeString("ko-KR") ?? "대기 중"}</span></footer>
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
        enabledProviders={enabledProviders}
        miniTotalVisible={miniTotalVisible}
        miniTotalPeriod={period}
        inventorySyncEnabled={runtime.inventorySyncEnabled}
        inventorySyncBusy={runtime.inventorySync.loading}
        claudeQuotaCapture={providerQuotas.claudeCapture}
        quotaBusy={providerQuotas.busy}
        theme={theme}
        allowSupabaseOverride={import.meta.env.DEV}
        onClose={() => setSettingsOpen(false)}
        onConfigureSupabase={(url, anonKey) => runtime.configureSupabase(url, anonKey)}
        onClearSupabaseConfig={() => runtime.clearSupabaseConfig()}
        onReturnToLogin={returnToLogin}
        onSaveCredential={(provider, credentials) => runtime.saveProviderCredential(provider, credentials)}
        onRemoveCredential={(provider) => runtime.removeProviderCredential(provider)}
        onRefreshProvider={(provider) => runtime.refreshProviderUsage(provider)}
        onUpdateSessionTitle={(sessionId, title) => runtime.updateSessionTitle(sessionId, title)}
        onSetAutostart={(enabled) => nativeSettings.toggleAutostart(enabled)}
        onConfigureGemini={() => nativeSettings.enableGeminiTelemetry()}
        onToggleProvider={(provider) => void updateCollectionProvider(provider)}
        onToggleMiniTotal={toggleMiniTotal}
        onSelectTheme={setTheme}
        onConfigureClaudeQuota={() => providerQuotas.enableClaudeCapture()}
        onSetInventorySyncEnabled={(enabled) => runtime.setInventorySyncEnabled(enabled)}
      />
    </div>
  );
}

function toggledProviderList(provider: Provider, current: Provider[]): Provider[] {
  return current.includes(provider)
    ? current.filter((item) => item !== provider)
    : ALL_PROVIDERS.filter((item) => current.includes(item) || item === provider);
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

function readPeriod(): Period {
  const stored = window.localStorage.getItem(DASHBOARD_PERIOD_KEY);
  return stored === "오늘" || stored === "30일" ? stored : "7일";
}
