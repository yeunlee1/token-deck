// AI 도구별 토큰 사용량을 통합해 보여주는 데스크톱 대시보드
import { useMemo, useState } from "react";
import { Icon, type IconName } from "./components/Icon";
import { UsageChart } from "./components/UsageChart";
import { tokenTotal, type UsageEvent } from "./core";
import { useLocalUsage } from "./hooks/useLocalUsage";
import "./styles.css";

type Period = "오늘" | "7일" | "30일";

const sampleProviders = [
  { name: "Codex", model: "GPT-5 · 앱 + CLI", value: "482K", percent: 78, delta: "+12.4%", tone: "ink", monogram: "CX" },
  { name: "Claude", model: "Opus 4.1 · Claude Code", value: "315K", percent: 52, delta: "+8.1%", tone: "lime", monogram: "CL" },
  { name: "Gemini", model: "2.5 Pro · CLI", value: "161K", percent: 27, delta: "−3.2%", tone: "violet", monogram: "GM" },
];

const sampleProjects = [
  { name: "newSteel", path: "github.com/acme/newsteel", value: "351K", share: 82, color: "ink" },
  { name: "WOS Helper", path: "github.com/acme/wos-sfc", value: "247K", share: 58, color: "violet" },
  { name: "Data Governance", path: "github.com/acme/governance", value: "196K", share: 46, color: "lime" },
  { name: "Personal Sandbox", path: "로컬 프로젝트", value: "164K", share: 38, color: "blue" },
];

const sampleDevices = [
  { name: "WORKSTATION-01", meta: "Windows 11 · 현재 기기", status: "수집 중", icon: "device" as IconName, current: true },
  { name: "SURFACE-LAPTOP", meta: "Windows 11 · 4분 전", status: "동기화됨", icon: "device" as IconName, current: false },
];

const chartSets: Record<Period, { label: string; codex: number; claude: number; gemini: number }[]> = {
  오늘: [
    { label: "09시", codex: 18, claude: 10, gemini: 6 }, { label: "11시", codex: 33, claude: 21, gemini: 8 },
    { label: "13시", codex: 26, claude: 30, gemini: 14 }, { label: "15시", codex: 51, claude: 25, gemini: 18 },
    { label: "17시", codex: 44, claude: 36, gemini: 13 }, { label: "19시", codex: 68, claude: 41, gemini: 22 },
    { label: "21시", codex: 57, claude: 48, gemini: 28 },
  ],
  "7일": [
    { label: "월", codex: 44, claude: 31, gemini: 18 }, { label: "화", codex: 52, claude: 26, gemini: 22 },
    { label: "수", codex: 48, claude: 38, gemini: 15 }, { label: "목", codex: 65, claude: 42, gemini: 24 },
    { label: "금", codex: 59, claude: 36, gemini: 29 }, { label: "토", codex: 22, claude: 19, gemini: 8 },
    { label: "일", codex: 39, claude: 28, gemini: 13 },
  ],
  "30일": [
    { label: "1주", codex: 38, claude: 25, gemini: 12 }, { label: "2주", codex: 54, claude: 33, gemini: 17 },
    { label: "3주", codex: 47, claude: 41, gemini: 22 }, { label: "4주", codex: 66, claude: 38, gemini: 29 },
    { label: "현재", codex: 71, claude: 49, gemini: 25 },
  ],
};

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
  else start.setDate(start.getDate() - (period === "7일" ? 6 : 29));
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
  const localUsage = useLocalUsage();
  const [period, setPeriod] = useState<Period>("7일");
  const [privacy, setPrivacy] = useState(true);
  const periodEvents = useMemo(() => usageInPeriod(localUsage.events, period), [localUsage.events, period]);
  const actualTotal = useMemo(() => periodEvents.reduce((sum, event) => sum + tokenTotal(event.tokens), 0), [periodEvents]);
  const hasActualData = localUsage.events.length > 0;
  const total = hasActualData ? actualTotal.toLocaleString("ko-KR") : period === "오늘" ? "127,840" : period === "7일" ? "958,240" : "3,821,700";

  const providers = useMemo(() => {
    if (!hasActualData) return sampleProviders;
    const totals = (["codex", "claude", "gemini"] as const).map((provider) => ({
      provider,
      tokens: periodEvents.filter((event) => event.provider === provider).reduce((sum, event) => sum + tokenTotal(event.tokens), 0),
    }));
    return totals.map(({ provider, tokens }) => ({
      ...providerInfo[provider],
      value: formatTokens(tokens),
      percent: actualTotal ? Math.round(tokens / actualTotal * 100) : 0,
      delta: tokens ? "수집됨" : "대기",
    }));
  }, [actualTotal, hasActualData, periodEvents]);

  const projects = useMemo(() => {
    if (!hasActualData) return sampleProjects;
    const totals = new Map<string, number>();
    periodEvents.forEach((event) => totals.set(event.projectId, (totals.get(event.projectId) ?? 0) + tokenTotal(event.tokens)));
    const max = Math.max(...totals.values(), 1);
    return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id, value], index) => ({
      name: `프로젝트 ${id.slice(-6).toUpperCase()}`,
      path: id.startsWith("git_") ? "Git 원격으로 통합됨" : "로컬 식별자",
      value: formatTokens(value), share: Math.round(value / max * 100), color: (["ink", "violet", "lime", "blue"] as const)[index],
    }));
  }, [hasActualData, periodEvents]);

  const connectedCount = Object.values(localUsage.integrations).filter(Boolean).length;
  const devices = hasActualData ? [{ name: "현재 Windows 기기", meta: "10초 간격 로컬 수집", status: "수집 중", icon: "device" as IconName, current: true }] : sampleDevices;

  const runSync = () => void localUsage.refresh();

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">대시보드 본문으로 이동</a>
      <aside className="sidebar" aria-label="앱 탐색">
        <div className="brand" aria-label="Token Deck 홈"><span className="brand-mark"><Icon name="activity" /></span><span className="brand-copy">TOKEN<small>DECK</small></span></div>
        <nav>
          <a href="#overview" className="nav-item active"><Icon name="activity" /><span>개요</span></a>
          <a href="#projects" className="nav-item"><Icon name="folder" /><span>프로젝트</span></a>
          <a href="#devices" className="nav-item"><Icon name="device" /><span>기기</span></a>
        </nav>
        <div className="sidebar-bottom">
          <button className="nav-item"><Icon name="settings" /><span>설정</span></button>
          <div className="account-chip"><span className="avatar">TD</span><div><strong>로컬 사용자</strong><small>Supabase 연결 대기</small></div><Icon name="chevron" /></div>
        </div>
      </aside>

      <main id="main" className="dashboard">
        <header className="topbar">
          <div><p className="kicker">통합 사용량 관제</p><h1>토큰 흐름을 확인하세요.</h1><p>모든 AI 코딩 도구의 사용 흐름을 한눈에 확인하세요.</p></div>
          <div className="top-actions"><span className="live-pill"><i /> {localUsage.error ? "수집 오류" : "실시간 수집 중"}</span><button className="icon-button" aria-label="지금 동기화" onClick={runSync}><Icon className={localUsage.syncing ? "spin" : ""} name="refresh" /></button></div>
        </header>

        <section id="overview" className="hero-grid" aria-label="사용량 요약">
          <article className="total-card">
            <div className="card-topline"><span className="eyebrow">TOTAL TOKENS</span><div className="segmented" aria-label="조회 기간">{(["오늘", "7일", "30일"] as Period[]).map((item) => <button key={item} className={period === item ? "selected" : ""} aria-pressed={period === item} onClick={() => setPeriod(item)}>{item}</button>)}</div></div>
            <div className="total-number"><strong>{total}</strong><span>tokens</span></div>
            <div className="delta"><Icon name="arrowUp" /> 지난 기간보다 <strong>9.8%</strong> 증가</div>
            <div className="pulse-orbit" aria-hidden="true"><span /><i /><b /></div>
          </article>
          <article className="status-card">
            <span className="eyebrow">SYNC HEALTH</span><div className="health-score"><strong>99.9</strong><span>%</span></div>
            <p>최근 동기화 <strong>{localUsage.syncing ? "진행 중" : localUsage.updatedAt ? "방금 전" : "대기 중"}</strong></p>
            <div className="status-row"><span><i className="ok" /> 연결된 기기</span><strong>{hasActualData ? 1 : 2}</strong></div>
            <div className="status-row"><span><i className="ok" /> 수집 커넥터</span><strong>{hasActualData ? connectedCount : 3} / 3</strong></div>
          </article>
        </section>

        <section className="provider-section">
          <SectionTitle eyebrow="PROVIDERS" title="공급사별 사용량" action={<button className="text-button">세부 내역 <Icon name="chevron" /></button>} />
          <div className="provider-grid">{providers.map((provider) => (
            <article className={`provider-card ${provider.tone}`} key={provider.name}>
              <div className="provider-heading"><span className="provider-logo">{provider.monogram}</span><div><h3>{provider.name}</h3><p>{provider.model}</p></div><span className={`provider-delta ${provider.delta.startsWith("−") ? "down" : ""}`}>{provider.delta}</span></div>
              <strong className="provider-value">{provider.value}</strong><span className="provider-unit">tokens</span>
              <div className="meter" aria-label={`${provider.name} 월간 한도 ${provider.percent}% 사용`}><i style={{ width: `${provider.percent}%` }} /></div>
              <div className="meter-label"><span>{hasActualData ? "기간 내 비중" : "월간 사용량"}</span><strong>{provider.percent}%</strong></div>
            </article>
          ))}</div>
        </section>

        <section className="content-grid">
          <article className="panel trend-panel">
            <SectionTitle eyebrow="ACTIVITY" title="사용량 추이" action={<div className="legend"><span className="codex">Codex</span><span className="claude">Claude</span><span className="gemini">Gemini</span></div>} />
            <UsageChart data={chartSets[period]} />
          </article>
          <article id="projects" className="panel project-panel">
            <SectionTitle eyebrow="PROJECTS" title="프로젝트 순위" action={<button className="icon-plain" aria-label="프로젝트 상세 보기"><Icon name="chevron" /></button>} />
            <ol className="project-list">{projects.map((project, index) => <li key={project.name}><span className="rank">0{index + 1}</span><div className="project-main"><div className="project-info"><span className={`project-dot ${project.color}`} /><div><strong>{project.name}</strong><small>{project.path}</small></div><b>{project.value}</b></div><div className="project-bar"><i className={project.color} style={{ width: `${project.share}%` }} /></div></div></li>)}</ol>
          </article>
        </section>

        <section className="lower-grid">
          <article id="devices" className="panel device-panel">
            <SectionTitle eyebrow="DEVICES" title="연결된 기기" action={<span className="count-badge">2대 활성</span>} />
            <div className="device-list">{devices.map((device) => <div className="device-row" key={device.name}><span className={`device-icon ${device.current ? "current" : ""}`}><Icon name={device.icon} /></span><div><strong>{device.name}</strong><small>{device.meta}</small></div><span className="device-status"><i />{device.status}</span></div>)}</div>
          </article>
          <article className="privacy-card">
            <div className="privacy-icon"><Icon name="lock" /></div><div className="privacy-copy"><span className="eyebrow">PRIVACY GUARD</span><h2>코드는 기기 밖으로 나가지 않아요.</h2><p>토큰 수치와 익명 프로젝트 ID만 암호화해 동기화합니다.</p><div className="privacy-meta"><Icon name="check" /> 전체 경로·프롬프트 수집 안 함</div></div>
            <button className={`toggle ${privacy ? "on" : ""}`} role="switch" aria-checked={privacy} aria-label="개인정보 보호 활성화" onClick={() => setPrivacy(!privacy)}><span /></button>
          </article>
        </section>

        <footer><span>Token Deck <b>v0.1.0</b></span><span><i /> {hasActualData ? "로컬 데이터 연결됨" : "브라우저 미리보기 데이터"}</span><span>마지막 갱신 · {localUsage.syncing ? "동기화 중" : localUsage.updatedAt?.toLocaleTimeString("ko-KR") ?? "대기 중"}</span></footer>
      </main>
    </div>
  );
}
