// 로컬 로그를 주기적으로 수집해 대시보드가 사용할 상태로 제공하는 React 훅
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  collectProjectDisplayNames,
  collectUsageDocuments,
  createCollectorState,
  readProjectNameOverrides,
  resolveProjectDisplayName,
  setProjectNameOverride,
  writeProjectNameOverrides,
  type ProjectNameMap,
  type Provider,
  type UsageEvent,
} from "../core";
import { getIntegrationStatus, scanLocalUsage, type IntegrationStatus } from "../platform/tauri";

export function getOrCreateDeviceId(): string {
  const existing = window.localStorage.getItem("token-deck-device-id");
  if (existing) return existing;
  const created = crypto.randomUUID();
  window.localStorage.setItem("token-deck-device-id", created);
  return created;
}

export function selectEnabledUsageEvents(events: UsageEvent[], providers: Provider[]): UsageEvent[] {
  return events.filter((event) => providers.includes(event.provider));
}

export function useLocalUsage(enabledProviders: Provider[]) {
  const collectorState = useRef(createCollectorState());
  const modifiedSince = useRef<number | undefined>(undefined);
  const providerKey = enabledProviders.join("|");
  const currentProviderKey = useRef(providerKey);
  const refreshQueue = useRef<Promise<void>>(Promise.resolve());
  const refreshes = useRef(new Map<string, Promise<void>>());
  currentProviderKey.current = providerKey;
  const [collectedEvents, setCollectedEvents] = useState<UsageEvent[]>([]);
  const [inferredProjectNames, setInferredProjectNames] = useState<ProjectNameMap>({});
  const [projectNameOverrides, setProjectNameOverrides] = useState<ProjectNameMap>(() => readProjectNameOverrides(window.localStorage));
  const [integrations, setIntegrations] = useState<IntegrationStatus>({ codex: false, claude: false, gemini: false });
  const [syncing, setSyncing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date>();
  const [error, setError] = useState<string>();

  const refresh = useCallback((): Promise<void> => {
    const existing = refreshes.current.get(providerKey);
    if (existing) return existing;
    setSyncing(true);
    const run = refreshQueue.current.catch(() => undefined).then(async () => {
      if (currentProviderKey.current !== providerKey) return;
      const scanStartedAt = Math.max(0, Math.floor(Date.now() / 1000) - 1);
      try {
        const [documents, status] = await Promise.all([
          scanLocalUsage(enabledProviders, modifiedSince.current),
          getIntegrationStatus(enabledProviders),
        ]);
        const incoming = collectUsageDocuments(documents, getOrCreateDeviceId(), collectorState.current);
        const discoveredNames = collectProjectDisplayNames(documents);
        if (Object.keys(discoveredNames).length) setInferredProjectNames((current) => ({ ...current, ...discoveredNames }));
        if (incoming.length) {
          setCollectedEvents((current) => {
            const byId = new Map(current.map((event) => [event.id, event]));
            incoming.forEach((event) => byId.set(event.id, event));
            return [...byId.values()];
          });
        }
        modifiedSince.current = Math.max(modifiedSince.current ?? 0, scanStartedAt);
        if (currentProviderKey.current !== providerKey) return;
        setIntegrations(status);
        setUpdatedAt(new Date());
        setError(undefined);
      } catch (cause) {
        if (currentProviderKey.current !== providerKey) return;
        setError(cause instanceof Error ? cause.message : "로컬 사용량을 읽지 못했습니다.");
      }
    });
    const task = run.finally(() => {
      if (refreshes.current.get(providerKey) === task) refreshes.current.delete(providerKey);
      if (currentProviderKey.current === providerKey) setSyncing(false);
    });
    refreshes.current.set(providerKey, task);
    refreshQueue.current = task.catch(() => undefined);
    return task;
  }, [enabledProviders, providerKey]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const events = useMemo(
    () => selectEnabledUsageEvents(collectedEvents, enabledProviders),
    [collectedEvents, enabledProviders, providerKey],
  );

  const projectNames = useMemo(() => Object.fromEntries(
    [...new Set([...Object.keys(inferredProjectNames), ...Object.keys(projectNameOverrides), ...events.map((event) => event.projectId)])]
      .map((projectId) => [projectId, resolveProjectDisplayName(projectId, inferredProjectNames, projectNameOverrides)]),
  ), [events, inferredProjectNames, projectNameOverrides]);

  const updateProjectName = useCallback(async (projectId: string, name: string) => {
    setProjectNameOverrides((current) => {
      const next = setProjectNameOverride(current, projectId, name);
      writeProjectNameOverrides(window.localStorage, next);
      return next;
    });
  }, []);

  return { events, integrations, syncing, updatedAt, error, refresh, inferredProjectNames, projectNames, projectNameOverrides, updateProjectName };
}
