// 선택한 AI 공급사의 최근 토큰 사용량을 작은 플로팅 패널에 표시한다
import { useMemo } from "react";
import { tokenTotal, type Provider, type UsageEvent } from "../core";
import { Icon } from "./Icon";

export type MiniSelection = "codex" | "claude" | "gemini" | "codex_claude";

interface MiniDashboardProps {
  events: UsageEvent[];
  selection: MiniSelection;
  updatedAt?: Date;
  syncing: boolean;
  onSelectionChange: (selection: MiniSelection) => void;
  onExit: () => void;
  onRefresh: () => void;
}

const options: Array<{ value: MiniSelection; label: string }> = [
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude" },
  { value: "codex_claude", label: "C + C" },
  { value: "gemini", label: "Gemini" },
];

const names: Record<Provider, string> = { codex: "Codex", claude: "Claude", gemini: "Gemini" };

function selectedProviders(selection: MiniSelection): Provider[] {
  return selection === "codex_claude" ? ["codex", "claude"] : [selection];
}

export function buildMiniUsage(events: UsageEvent[], selection: MiniSelection, now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 6);
  const recent = events.filter((event) => new Date(event.occurredAt) >= start && new Date(event.occurredAt) <= now);
  return selectedProviders(selection).map((provider) => ({
    provider,
    total: recent.filter((event) => event.provider === provider).reduce((sum, event) => sum + tokenTotal(event.tokens), 0),
    events: recent.filter((event) => event.provider === provider).length,
  }));
}

function compact(value: number): string {
  return new Intl.NumberFormat("ko-KR", { notation: value > 9_999 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

export function MiniDashboard(props: MiniDashboardProps) {
  const rows = useMemo(() => buildMiniUsage(props.events, props.selection), [props.events, props.selection]);
  const total = rows.reduce((sum, row) => sum + row.total, 0);

  return <main className="mini-dashboard" aria-label="Token Deck 미니 모드">
    <header className="mini-header">
      <div className="mini-brand"><span><Icon name="activity" /></span><div><strong>TOKEN DECK</strong><small>최근 7일</small></div></div>
      <div className="mini-actions"><button aria-label="사용량 새로고침" onClick={props.onRefresh}><Icon className={props.syncing ? "spin" : ""} name="refresh" /></button><button aria-label="일반 모드로 전환" onClick={props.onExit}>↗</button></div>
    </header>
    <div className="mini-selector" aria-label="표시할 공급사">{options.map((option) => <button key={option.value} aria-pressed={props.selection === option.value} onClick={() => props.onSelectionChange(option.value)}>{option.label}</button>)}</div>
    <section className="mini-total" aria-live="polite"><span>SELECTED TOKENS</span><strong>{compact(total)}</strong><small>tokens</small></section>
    <section className={`mini-provider-rows ${rows.length === 1 ? "single" : ""}`}>{rows.map((row) => <article key={row.provider} className={row.provider}>
      <div><i /><strong>{names[row.provider]}</strong><small>{row.events.toLocaleString("ko-KR")} events</small></div><b>{compact(row.total)}</b>
    </article>)}</section>
    <footer className="mini-footer"><span><i /> LIVE</span><small>{props.syncing ? "수집 중" : props.updatedAt?.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) ?? "대기 중"}</small></footer>
  </main>;
}
