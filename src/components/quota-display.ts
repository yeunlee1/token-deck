// 정액제 사용 한도의 잔여 퍼센트와 화면 상태를 일관되게 표현한다
import type { Provider } from "../core";

export interface QuotaWindowStatus {
  usedPercent: number;
  remainingPercent: number;
  windowMinutes: number;
  resetsAt: number | null;
}

export interface ProviderQuotaStatus {
  provider: Provider;
  supported: boolean;
  planType: string | null;
  fiveHour: QuotaWindowStatus | null;
  weekly: QuotaWindowStatus | null;
  daily: QuotaWindowStatus | null;
  message: string | null;
  updatedAt: number | null;
}

export function remainingLabel(window: QuotaWindowStatus | null): string {
  if (!window) return "—";
  return `${Math.round(Math.max(0, Math.min(100, window.remainingPercent)))}%`;
}

export function remainingTone(window: QuotaWindowStatus | null): "unknown" | "safe" | "watch" | "low" {
  if (!window) return "unknown";
  if (window.remainingPercent <= 20) return "low";
  if (window.remainingPercent <= 45) return "watch";
  return "safe";
}

export function quotaStatusLabel(quota: ProviderQuotaStatus | undefined): string {
  if (!quota) return "확인 중";
  if (quota.supported) return quota.planType || "정액제 연결됨";
  return quota.message || "한도 정보 없음";
}
