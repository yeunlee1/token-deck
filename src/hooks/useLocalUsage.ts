// 로컬 로그를 주기적으로 수집해 대시보드가 사용할 상태로 제공하는 React 훅
import { useCallback, useEffect, useRef, useState } from "react";
import { collectUsageDocuments, createCollectorState, type UsageEvent } from "../core";
import { getIntegrationStatus, scanLocalUsage, type IntegrationStatus } from "../platform/tauri";

export function getOrCreateDeviceId(): string {
  const existing = window.localStorage.getItem("token-deck-device-id");
  if (existing) return existing;
  const created = crypto.randomUUID();
  window.localStorage.setItem("token-deck-device-id", created);
  return created;
}

export function useLocalUsage() {
  const collectorState = useRef(createCollectorState());
  const modifiedSince = useRef<number | undefined>(undefined);
  const [events, setEvents] = useState<UsageEvent[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationStatus>({ codex: false, claude: false, gemini: false });
  const [syncing, setSyncing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    setSyncing(true);
    try {
      const scanStartedAt = Math.max(0, Math.floor(Date.now() / 1000) - 1);
      const [documents, status] = await Promise.all([scanLocalUsage(modifiedSince.current), getIntegrationStatus()]);
      const incoming = collectUsageDocuments(documents, getOrCreateDeviceId(), collectorState.current);
      if (incoming.length) {
        setEvents((current) => {
          const byId = new Map(current.map((event) => [event.id, event]));
          incoming.forEach((event) => byId.set(event.id, event));
          return [...byId.values()];
        });
      }
      setIntegrations(status);
      modifiedSince.current = scanStartedAt;
      setUpdatedAt(new Date());
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "로컬 사용량을 읽지 못했습니다.");
    } finally {
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { events, integrations, syncing, updatedAt, error, refresh };
}
