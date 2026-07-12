// 선택한 AI 공급사의 정액제 잔여 한도를 작은 플로팅 패널에 표시한다
import { useMemo } from "react";
import type { Provider } from "../core";
import { Icon } from "./Icon";
import { quotaStatusLabel, remainingLabel, remainingTone, type ProviderQuotaStatus } from "./quota-display";

interface MiniDashboardProps {
  quotas: ProviderQuotaStatus[];
  providers: Provider[];
  showTotal: boolean;
  totalTokens: number;
  totalPeriod: string;
  updatedAt?: Date;
  syncing: boolean;
  error?: string;
  pinned: boolean;
  onToggleProvider: (provider: Provider) => void;
  onExit: () => void;
  onTogglePinned: () => void;
}

const options: Array<{ value: Provider; label: string }> = [{ value: "codex", label: "Codex" }, { value: "claude", label: "Claude" }, { value: "gemini", label: "Gemini" }];
const names: Record<Provider, string> = { codex: "Codex", claude: "Claude", gemini: "Gemini" };

export function MiniDashboard(props: MiniDashboardProps) {
  const quotaByProvider = useMemo(() => new Map(props.quotas.map((quota) => [quota.provider, quota])), [props.quotas]);
  const compactTotal = new Intl.NumberFormat("ko-KR", { notation: props.totalTokens > 9999 ? "compact" : "standard", maximumFractionDigits: 1 }).format(props.totalTokens);

  return <main className="mini-dashboard" aria-label="Token Deck 미니 모드">
    <header className="mini-header" data-tauri-drag-region>
      <div className="mini-brand" data-tauri-drag-region><span><Icon name="activity" /></span><div data-tauri-drag-region><strong data-tauri-drag-region>TOKEN DECK</strong><small data-tauri-drag-region>정액제 잔여 한도</small></div></div>
      {props.showTotal && <div className="mini-total" aria-label={`${props.totalPeriod} 총 토큰 ${props.totalTokens.toLocaleString("ko-KR")}`} aria-live="polite" data-tauri-drag-region><span data-tauri-drag-region>{props.totalPeriod} TOTAL</span><div data-tauri-drag-region><strong data-tauri-drag-region>{compactTotal}</strong><small data-tauri-drag-region>tokens</small></div></div>}
      <div className="mini-actions"><button className={props.pinned ? "pinned" : ""} aria-label={props.pinned ? "창 고정 해제" : "창 항상 위에 고정"} aria-pressed={Boolean(props.pinned)} onClick={props.onTogglePinned}><Icon name={props.pinned ? "pin" : "pinOff"} /></button><button aria-label="일반 모드로 전환" onClick={props.onExit}>↗</button></div>
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
    <footer className="mini-footer"><span><i /> {props.syncing ? "SYNC" : "LIVE"}</span><small>{props.syncing ? "확인 중" : props.updatedAt?.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) ?? "대기 중"}</small></footer>
  </main>;
}
