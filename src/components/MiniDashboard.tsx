// 선택한 AI 공급사의 정액제 잔여 한도를 작은 플로팅 패널에 표시한다
import { useMemo, type CSSProperties } from "react";
import type { Provider } from "../core";
import { Icon } from "./Icon";
import { quotaStatusLabel, remainingLabel, remainingTone, type ProviderQuotaStatus } from "./quota-display";

interface MiniDashboardProps {
  quotas: ProviderQuotaStatus[];
  providers: Provider[];
  opacity: number;
  updatedAt?: Date;
  syncing: boolean;
  error?: string;
  onToggleProvider: (provider: Provider) => void;
  onOpacityChange: (opacity: number) => void;
  onExit: () => void;
  onRefresh: () => void;
}

const options: Array<{ value: Provider; label: string }> = [{ value: "codex", label: "Codex" }, { value: "claude", label: "Claude" }, { value: "gemini", label: "Gemini" }];
const names: Record<Provider, string> = { codex: "Codex", claude: "Claude", gemini: "Gemini" };

export function MiniDashboard(props: MiniDashboardProps) {
  const quotaByProvider = useMemo(() => new Map(props.quotas.map((quota) => [quota.provider, quota])), [props.quotas]);
  const style = { "--mini-opacity": props.opacity / 100 } as CSSProperties;

  return <main className="mini-dashboard" aria-label="Token Deck 미니 모드" style={style}>
    <header className="mini-header">
      <div className="mini-brand"><span><Icon name="activity" /></span><div><strong>TOKEN DECK</strong><small>정액제 잔여 한도</small></div></div>
      <div className="mini-actions"><button aria-label="한도 새로고침" onClick={props.onRefresh}><Icon className={props.syncing ? "spin" : ""} name="refresh" /></button><button aria-label="일반 모드로 전환" onClick={props.onExit}>↗</button></div>
    </header>
    <div className="mini-selector" aria-label="표시할 공급사">{options.map((option) => <button key={option.value} aria-pressed={props.providers.includes(option.value)} onClick={() => props.onToggleProvider(option.value)}>{option.label}</button>)}</div>
    <div className="mini-columns" aria-hidden="true"><span>공급사</span><span>5시간 잔여</span><span>주간 잔여</span></div>
    <section className="mini-provider-rows" aria-live="polite">{props.providers.map((provider) => {
      const quota = quotaByProvider.get(provider);
      return <article key={provider} className={provider}>
        <div><i /><strong>{names[provider]}</strong><small>{quotaStatusLabel(quota)}</small></div>
        <b className={remainingTone(quota?.fiveHour ?? null)}><small>5H LEFT</small>{remainingLabel(quota?.fiveHour ?? null)}</b>
        <b className={remainingTone(quota?.weekly ?? null)}><small>7D LEFT</small>{remainingLabel(quota?.weekly ?? null)}</b>
      </article>;
    })}</section>
    {props.error && <p className="mini-error" role="alert">{props.error}</p>}
    <footer className="mini-footer"><span><i /> {props.syncing ? "SYNC" : "LIVE"}</span><label><span>불투명도</span><input type="range" min="0" max="100" step="1" value={props.opacity} aria-label="미니 모드 불투명도" onInput={(event) => props.onOpacityChange(Number(event.currentTarget.value))} onChange={(event) => props.onOpacityChange(Number(event.currentTarget.value))} /><output>{props.opacity}%</output></label><small>{props.syncing ? "확인 중" : props.updatedAt?.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) ?? "대기 중"}</small></footer>
  </main>;
}
