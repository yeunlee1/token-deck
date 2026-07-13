// 공급사별 구독 한도와 Claude 상태 표시 수집 설정을 주기적으로 갱신하는 React 훅
import { useCallback, useEffect, useRef, useState } from "react";
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
const ALL_PROVIDERS: QuotaProvider[] = ["codex", "claude", "gemini"];

function collectionDisabledStatus(provider: QuotaProvider): ProviderQuotaStatus {
  return {
    provider,
    supported: false,
    planType: null,
    fiveHour: null,
    weekly: null,
    daily: null,
    message: "설정에서 수집이 꺼져 있습니다.",
    updatedAt: null,
  };
}

export function quotaRecord(statuses: ProviderQuotaStatus[], enabledProviders: QuotaProvider[] = ALL_PROVIDERS): Record<QuotaProvider, ProviderQuotaStatus> {
  const fallback = new Map(unsupportedQuotaStatuses(enabledProviders).map((status) => [status.provider, status]));
  const received = new Map(statuses.filter((status) => enabledProviders.includes(status.provider)).map((status) => [status.provider, status]));
  return Object.fromEntries(ALL_PROVIDERS.map((provider) => [
    provider,
    received.get(provider) ?? fallback.get(provider) ?? collectionDisabledStatus(provider),
  ])) as Record<QuotaProvider, ProviderQuotaStatus>;
}

export function pendingQuotaRecord(enabledProviders: QuotaProvider[]): Record<QuotaProvider, ProviderQuotaStatus> {
  return Object.fromEntries(ALL_PROVIDERS.map((provider) => [
    provider,
    enabledProviders.includes(provider) ? {
      provider,
      supported: false,
      planType: null,
      fiveHour: null,
      weekly: null,
      daily: null,
      message: "잔여 한도를 확인 중입니다.",
      updatedAt: null,
    } : collectionDisabledStatus(provider),
  ])) as Record<QuotaProvider, ProviderQuotaStatus>;
}

export function latestCurrentQuotaUpdate(statuses: ProviderQuotaStatus[]): Date | undefined {
  const seconds = statuses.reduce<number | undefined>((latest, status) => {
    if (!status.supported || status.updatedAt === null) return latest;
    return latest === undefined ? status.updatedAt : Math.max(latest, status.updatedAt);
  }, undefined);
  return seconds === undefined ? undefined : new Date(seconds * 1_000);
}

export function useProviderQuotas(enabledProviders: QuotaProvider[] = ALL_PROVIDERS, pollIntervalMs = 30_000) {
  const providerKey = enabledProviders.join("|");
  const currentProviderKey = useRef(providerKey);
  const refreshes = useRef(new Map<string, Promise<void>>());
  currentProviderKey.current = providerKey;
  const [quotas, setQuotas] = useState(() => pendingQuotaRecord(enabledProviders));
  const [claudeCapture, setClaudeCapture] = useState<ClaudeQuotaCaptureStatus>(EMPTY_CAPTURE);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [updatedAt, setUpdatedAt] = useState<Date>();

  const refresh = useCallback((): Promise<void> => {
    const existing = refreshes.current.get(providerKey);
    if (existing) return existing;
    setLoading(true);
    const run = (async () => {
      if (currentProviderKey.current !== providerKey) return;
      try {
        const [statuses, capture] = await Promise.all([
          getQuotaStatuses(enabledProviders),
          enabledProviders.includes("claude") ? getClaudeQuotaCaptureStatus() : Promise.resolve(EMPTY_CAPTURE),
        ]);
        if (currentProviderKey.current !== providerKey) return;
        setQuotas(quotaRecord(statuses, enabledProviders));
        setClaudeCapture(capture);
        setUpdatedAt(latestCurrentQuotaUpdate(statuses));
        setError(undefined);
      } catch (cause) {
        if (currentProviderKey.current !== providerKey) return;
        setError(cause instanceof Error ? cause.message : "공급사 한도 상태를 확인하지 못했습니다.");
      }
    })();
    const task = run.finally(() => {
      if (refreshes.current.get(providerKey) === task) refreshes.current.delete(providerKey);
      if (currentProviderKey.current === providerKey) setLoading(false);
    });
    refreshes.current.set(providerKey, task);
    return task;
  }, [enabledProviders, providerKey]);

  useEffect(() => {
    setQuotas(pendingQuotaRecord(enabledProviders));
    setClaudeCapture((current) => enabledProviders.includes("claude") ? current : EMPTY_CAPTURE);
    setError(undefined);
    setUpdatedAt(undefined);
    setLoading(true);
  }, [enabledProviders, providerKey]);

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
    if (!enabledProviders.includes("claude")) throw new Error("Claude 수집을 먼저 활성화해 주세요.");
    setBusy(true);
    try {
      setClaudeCapture(await configureClaudeQuotaCapture());
      const currentRefresh = refreshes.current.get(providerKey);
      if (currentRefresh) await currentRefresh;
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Claude 한도 수집을 설정하지 못했습니다.");
      throw cause;
    } finally {
      setBusy(false);
    }
  }, [enabledProviders, providerKey, refresh]);

  return { quotas, claudeCapture, loading, busy, error, updatedAt, refresh, enableClaudeCapture };
}
