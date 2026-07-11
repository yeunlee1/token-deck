// 공급사별 구독 한도와 Claude 상태 표시 수집 설정을 주기적으로 갱신하는 React 훅
import { useCallback, useEffect, useState } from "react";
import {
  configureClaudeQuotaCapture,
  getClaudeQuotaCaptureStatus,
  getQuotaStatuses,
  unsupportedQuotaStatuses,
  type ClaudeQuotaCaptureStatus,
  type ProviderQuotaStatus,
  type QuotaProvider,
} from "../platform/native";

const EMPTY_CAPTURE: ClaudeQuotaCaptureStatus = {
  configured: false,
  settingsPath: "",
  dataPath: "",
  hasData: false,
  existingStatusLine: false,
};

export function quotaRecord(statuses: ProviderQuotaStatus[]): Record<QuotaProvider, ProviderQuotaStatus> {
  const fallback = unsupportedQuotaStatuses();
  const byProvider = new Map([...fallback, ...statuses].map((status) => [status.provider, status]));
  return Object.fromEntries((["codex", "claude", "gemini"] as QuotaProvider[]).map((provider) => [provider, byProvider.get(provider)!])) as Record<QuotaProvider, ProviderQuotaStatus>;
}

export function useProviderQuotas(pollIntervalMs = 30_000) {
  const [quotas, setQuotas] = useState(() => quotaRecord([]));
  const [claudeCapture, setClaudeCapture] = useState<ClaudeQuotaCaptureStatus>(EMPTY_CAPTURE);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [updatedAt, setUpdatedAt] = useState<Date>();

  const refresh = useCallback(async () => {
    try {
      const [statuses, capture] = await Promise.all([getQuotaStatuses(), getClaudeQuotaCaptureStatus()]);
      setQuotas(quotaRecord(statuses));
      setClaudeCapture(capture);
      setUpdatedAt(new Date());
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "공급사 한도 상태를 확인하지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (pollIntervalMs <= 0) return;
    const timer = window.setInterval(() => void refresh(), Math.max(5_000, pollIntervalMs));
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pollIntervalMs, refresh]);

  const enableClaudeCapture = useCallback(async () => {
    setBusy(true);
    try {
      setClaudeCapture(await configureClaudeQuotaCapture());
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Claude 한도 수집을 설정하지 못했습니다.");
      throw cause;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return { quotas, claudeCapture, loading, busy, error, updatedAt, refresh, enableClaudeCapture };
}
