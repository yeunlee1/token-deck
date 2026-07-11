// 선택한 AI 공급사의 최근 토큰 사용량을 작은 플로팅 패널에 표시한다
import { useMemo, type CSSProperties } from "react";
import { buildProviderWindowUsage, type Provider, type UsageEvent } from "../core";
import { Icon } from "./Icon";

interface MiniDashboardProps {
  events: UsageEvent[];
  providers: Provider[];
  opacity: number;
  updatedAt?: Date;
  syncing: boolean;
  onToggleProvider: (provider: Provider) => void;
  onOpacityChange: (opacity: number) => void;
  onExit: () => void;
  onRefresh: () => void;
}

const options: Array<{ value: Provider; label: string }> = [{ value: "codex", label: "Codex" }, { value: "claude", label: "Claude" }, { value: "gemini", label: "Gemini" }];

const names: Record<Provider, string> = { codex: "Codex", claude: "Claude", gemini: "Gemini" };

function compact(value: number): string {
  return new Intl.NumberFormat("ko-KR", { notation: value > 9_999 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

export function MiniDashboard(props: MiniDashboardProps) {
  const rows = useMemo(() => buildProviderWindowUsage(props.events, props.providers), [props.events, props.providers]);
  const style = { "--mini-opacity": props.opacity / 100 } as CSSProperties;

  return <main className="mini-dashboard" aria-label="Token Deck 미니 모드" style={style}>
    <header className="mini-header">
      <div className="mini-brand"><span><Icon name="activity" /></span><div><strong>TOKEN DECK</strong><small>5시간 · 최근 7일</small></div></div>
      <div className="mini-actions"><button aria-label="사용량 새로고침" onClick={props.onRefresh}><Icon className={props.syncing ? "spin" : ""} name="refresh" /></button><button aria-label="일반 모드로 전환" onClick={props.onExit}>↗</button></div>
    </header>
    <div className="mini-selector" aria-label="표시할 공급사">{options.map((option) => <button key={option.value} aria-pressed={props.providers.includes(option.value)} onClick={() => props.onToggleProvider(option.value)}>{option.label}</button>)}</div>
    <div className="mini-columns" aria-hidden="true"><span>공급사</span><span>최근 5시간</span><span>최근 7일</span></div>
    <section className="mini-provider-rows" aria-live="polite">{rows.map((row) => <article key={row.provider} className={row.provider}>
      <div><i /><strong>{names[row.provider]}</strong><small>{row.weekEvents.toLocaleString("ko-KR")} events</small></div><b><small>5H</small>{compact(row.fiveHours)}</b><b><small>7D</small>{compact(row.week)}</b>
    </article>)}</section>
    <footer className="mini-footer"><span><i /> LIVE</span><label><span>불투명도</span><input type="range" min="0" max="100" step="1" value={props.opacity} aria-label="미니 모드 불투명도" onInput={(event) => props.onOpacityChange(Number(event.currentTarget.value))} onChange={(event) => props.onOpacityChange(Number(event.currentTarget.value))} /><output>{props.opacity}%</output></label><small>{props.syncing ? "수집 중" : props.updatedAt?.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) ?? "대기 중"}</small></footer>
  </main>;
}
