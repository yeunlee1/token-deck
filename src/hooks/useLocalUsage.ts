// 로컬 로그를 주기적으로 수집해 대시보드가 사용할 상태로 제공하는 React 훅
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyCodexCumulativeBaselines,
  collectProjectDisplayNames,
  collectUsageDocuments,
  createCollectorState,
  pruneCodexCumulativeCheckpoints,
  readProjectNameOverrides,
  resolveProjectDisplayName,
  setProjectNameOverride,
  writeProjectNameOverrides,
  type CollectorState,
  type ProjectNameMap,
  type Provider,
  type UsageEvent,
} from "../core";
import { commitScanCursors, getIntegrationStatus, loadLocalProjectNames, loadLocalUsageState, saveLocalProjectNames, saveLocalUsageCache, scanLocalUsage, type IntegrationStatus, type LocalUsageOwnershipState, type LocalUsageStateSnapshot } from "../platform/tauri";

const MAX_LOCAL_USAGE_CACHE_EVENTS = 50_000;

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

export interface ProviderSelectionGeneration {
  key: string;
  generation: number;
}

export function updateProviderSelectionGeneration(
  current: ProviderSelectionGeneration,
  nextKey: string,
): ProviderSelectionGeneration {
  return current.key === nextKey
    ? current
    : { key: nextKey, generation: current.generation + 1 };
}

export function mergeLocalUsageEvents(current: UsageEvent[], incoming: UsageEvent[]): UsageEvent[] {
  const byId = new Map(current.map((event) => [event.id, event]));
  incoming.forEach((event) => byId.set(event.id, event));
  const merged = [...byId.values()];
  if (merged.length <= MAX_LOCAL_USAGE_CACHE_EVENTS) return merged;
  return merged
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
    .slice(-MAX_LOCAL_USAGE_CACHE_EVENTS);
}

export function collectorStateFromUsageEvents(events: UsageEvent[]): CollectorState {
  const state = createCollectorState();
  for (const event of events) {
    if (event.provider === "codex") {
      const key = `${event.deviceId}:${event.sessionId}`;
      const current = state.codexCumulative[key] ?? { input: 0, cached: 0, output: 0, reasoning: 0, tool: 0 };
      state.codexCumulative[key] = {
        input: current.input + event.tokens.input,
        cached: current.cached + event.tokens.cached,
        output: current.output + event.tokens.output,
        reasoning: current.reasoning + event.tokens.reasoning,
        tool: current.tool + event.tokens.tool,
      };
    }
    if (event.provider === "claude" && event.requestId) {
      state.claudeRequestIds.add(`${event.deviceId}:${event.requestId}`);
    }
    if (event.provider === "gemini" && event.requestId) {
      state.geminiEventIds.add(`${event.deviceId}:gemini-source:${event.requestId}`);
    }
  }
  return state;
}

function cloneCollectorState(state: CollectorState): CollectorState {
  return {
    codexCumulative: Object.fromEntries(
      Object.entries(state.codexCumulative).map(([key, tokens]) => [key, { ...tokens }]),
    ),
    codexRetiredSessionFilter: state.codexRetiredSessionFilter,
    claudeRequestIds: new Set(state.claudeRequestIds),
    geminiEventIds: new Set(state.geminiEventIds),
  };
}

export async function restoreLocalUsageCache(
  loadEvents: () => Promise<UsageEvent[]>,
  loadProjectNames: () => Promise<ProjectNameMap>,
  apply: (events: UsageEvent[], projectNames: ProjectNameMap) => void | Promise<void>,
): Promise<void> {
  const [events, projectNames] = await Promise.all([loadEvents(), loadProjectNames()]);
  await apply(mergeLocalUsageEvents([], events), projectNames);
}

export async function restoreLocalUsageState(
  loadState: () => Promise<LocalUsageStateSnapshot>,
  loadProjectNames: () => Promise<ProjectNameMap>,
  apply: (
    events: UsageEvent[],
    ownership: LocalUsageOwnershipState | null,
    codexCumulative: CollectorState["codexCumulative"],
    codexRetiredSessionFilter: string,
    projectNames: ProjectNameMap,
  ) => void | Promise<void>,
): Promise<void> {
  const [state, projectNames] = await Promise.all([
    loadState(),
    loadProjectNames().catch(() => ({})),
  ]);
  await apply(
    mergeLocalUsageEvents([], state.events),
    state.ownership,
    state.codexCumulative,
    state.codexRetiredSessionFilter ?? "",
    projectNames,
  );
}

export async function finalizeLocalUsageScan(
  persist: () => Promise<void>,
  commit: () => Promise<boolean>,
  shouldLoadStatus: () => boolean,
  loadStatus: () => Promise<IntegrationStatus>,
): Promise<{ committed: boolean; status?: IntegrationStatus }> {
  await persist();
  const committed = await commit();
  if (!committed || !shouldLoadStatus()) return { committed };
  return { committed, status: await loadStatus() };
}

export async function runFreshScanAfterPending(
  generation: number,
  currentGeneration: () => number,
  pending: Promise<boolean> | undefined,
  refresh: () => Promise<boolean>,
): Promise<boolean> {
  if (pending) await pending;
  if (currentGeneration() !== generation) return false;
  return refresh();
}

export function useLocalUsage(
  enabledProviders: Provider[],
  prepareRestoredEvents?: (
    events: UsageEvent[],
    ownership: LocalUsageOwnershipState | null,
    codexCumulative: CollectorState["codexCumulative"],
    codexRetiredSessionFilter: string,
  ) => Promise<void>,
  getOwnershipOwnerHash?: () => string | undefined,
  persistUsageState?: (
    events: UsageEvent[],
    incoming: UsageEvent[],
    codexCumulative: CollectorState["codexCumulative"],
    codexRetiredSessionFilter: string,
    ownerHash?: string,
  ) => Promise<void>,
) {
  const collectorState = useRef(createCollectorState());
  const modifiedSince = useRef<number | undefined>(undefined);
  const providerKey = enabledProviders.join("|");
  const providerSelection = useRef<ProviderSelectionGeneration>({ key: providerKey, generation: 0 });
  const refreshQueue = useRef<Promise<void>>(Promise.resolve());
  const refreshes = useRef(new Map<number, Promise<boolean>>());
  const collectedEventsRef = useRef<UsageEvent[]>([]);
  const inferredProjectNamesRef = useRef<ProjectNameMap>({});
  const cacheWrites = useRef<Promise<void>>(Promise.resolve());
  const cacheRevision = useRef(0);
  const cacheDirty = useRef(false);
  providerSelection.current = updateProviderSelectionGeneration(providerSelection.current, providerKey);
  const [collectedEvents, setCollectedEvents] = useState<UsageEvent[]>([]);
  const [cacheReady, setCacheReady] = useState(false);
  const [inferredProjectNames, setInferredProjectNames] = useState<ProjectNameMap>({});
  const [projectNameOverrides, setProjectNameOverrides] = useState<ProjectNameMap>(() => readProjectNameOverrides(window.localStorage));
  const [integrations, setIntegrations] = useState<IntegrationStatus>({ codex: false, claude: false, gemini: false });
  const [syncing, setSyncing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date>();
  const [error, setError] = useState<string>();

  const persistLocalUsageState = useCallback(async (
    incoming: UsageEvent[] = [],
    codexCumulative: CollectorState["codexCumulative"] = collectorState.current.codexCumulative,
    codexRetiredSessionFilter = collectorState.current.codexRetiredSessionFilter,
    ownerHash?: string,
  ): Promise<void> => {
    if (!cacheDirty.current) return;
    const revision = cacheRevision.current;
    const eventSnapshot = collectedEventsRef.current;
    const projectNameSnapshot = inferredProjectNamesRef.current;
    const task = cacheWrites.current.catch(() => undefined).then(async () => {
      if (persistUsageState) {
        await persistUsageState(
          eventSnapshot,
          incoming,
          codexCumulative,
          codexRetiredSessionFilter,
          ownerHash,
        );
      } else {
        await saveLocalUsageCache(eventSnapshot);
      }
      await saveLocalProjectNames(projectNameSnapshot);
    });
    cacheWrites.current = task.catch(() => undefined);
    await task;
    if (cacheRevision.current === revision) cacheDirty.current = false;
  }, [persistUsageState]);

  useEffect(() => {
    let active = true;
    void restoreLocalUsageState(loadLocalUsageState, loadLocalProjectNames, async (
      events,
      ownership,
      codexCumulative,
      codexRetiredSessionFilter,
      projectNames,
    ) => {
      await prepareRestoredEvents?.(
        events,
        ownership,
        codexCumulative,
        codexRetiredSessionFilter,
      );
      if (!active) return;
      collectedEventsRef.current = events;
      inferredProjectNamesRef.current = projectNames;
      const restoredCollectorState = collectorStateFromUsageEvents(events);
      if (Object.keys(codexCumulative).length) {
        restoredCollectorState.codexCumulative = Object.fromEntries(
          Object.entries(codexCumulative).map(([key, tokens]) => [key, { ...tokens }]),
        );
      }
      restoredCollectorState.codexRetiredSessionFilter = codexRetiredSessionFilter;
      collectorState.current = restoredCollectorState;
      setCollectedEvents(events);
      setInferredProjectNames(projectNames);
    }).then(() => {
      if (active) setCacheReady(true);
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : "로컬 사용량 캐시를 읽지 못했습니다.");
    });
    return () => { active = false; };
  }, [prepareRestoredEvents]);

  const refresh = useCallback((): Promise<boolean> => {
    if (!cacheReady) return Promise.resolve(false);
    const generation = providerSelection.current.generation;
    const existing = refreshes.current.get(generation);
    if (existing) return existing;
    setSyncing(true);
    const run = refreshQueue.current.catch(() => undefined).then(async () => {
      if (providerSelection.current.generation !== generation) return false;
      const scanStartedAt = Math.max(0, Math.floor(Date.now() / 1000) - 1);
      const scanOwnerHash = getOwnershipOwnerHash?.();
      try {
        const scan = await scanLocalUsage(enabledProviders, modifiedSince.current);
        const documents = scan.documents;
        const nextCollectorState = cloneCollectorState(collectorState.current);
        const deviceId = getOrCreateDeviceId();
        const codexBaselines = scan.codexBaselines ?? [];
        if (codexBaselines.length) {
          applyCodexCumulativeBaselines(codexBaselines.join("\n"), deviceId, nextCollectorState);
          cacheRevision.current += 1;
          cacheDirty.current = true;
        }
        const incoming = collectUsageDocuments(documents, deviceId, nextCollectorState);
        if (documents.some((document) => document.provider === "codex")) {
          cacheRevision.current += 1;
          cacheDirty.current = true;
        }
        const discoveredNames = collectProjectDisplayNames(documents);
        let namesToPublish: ProjectNameMap | undefined;
        let eventsToPublish: UsageEvent[] | undefined;
        if (Object.keys(discoveredNames).length) {
          const mergedNames = { ...inferredProjectNamesRef.current, ...discoveredNames };
          inferredProjectNamesRef.current = mergedNames;
          cacheRevision.current += 1;
          cacheDirty.current = true;
          namesToPublish = mergedNames;
        }
        if (incoming.length) {
          const merged = mergeLocalUsageEvents(collectedEventsRef.current, incoming);
          collectedEventsRef.current = merged;
          cacheRevision.current += 1;
          cacheDirty.current = true;
          eventsToPublish = merged;
        }
        const retiredCheckpoints = pruneCodexCumulativeCheckpoints(nextCollectorState);
        if (retiredCheckpoints > 0) {
          cacheRevision.current += 1;
          cacheDirty.current = true;
        }
        const finalized = await finalizeLocalUsageScan(
          async () => {
            await persistLocalUsageState(
              incoming,
              nextCollectorState.codexCumulative,
              nextCollectorState.codexRetiredSessionFilter,
              scanOwnerHash,
            );
            collectorState.current = nextCollectorState;
            if (namesToPublish) setInferredProjectNames(namesToPublish);
            if (eventsToPublish) setCollectedEvents(eventsToPublish);
          },
          async () => {
            const committed = await commitScanCursors(scan.commitToken);
            if (committed) modifiedSince.current = Math.max(modifiedSince.current ?? 0, scanStartedAt);
            return committed;
          },
          () => providerSelection.current.generation === generation,
          () => getIntegrationStatus(enabledProviders),
        );
        if (providerSelection.current.generation !== generation) return false;
        if (!finalized.committed || !finalized.status) return false;
        setIntegrations(finalized.status);
        setUpdatedAt(new Date());
        setError(undefined);
        return true;
      } catch (cause) {
        if (providerSelection.current.generation !== generation) return false;
        setError(cause instanceof Error ? cause.message : "로컬 사용량을 읽지 못했습니다.");
        return false;
      }
    });
    const task = run.finally(() => {
      if (refreshes.current.get(generation) === task) refreshes.current.delete(generation);
      if (providerSelection.current.generation === generation) setSyncing(false);
    });
    refreshes.current.set(generation, task);
    refreshQueue.current = task.then(() => undefined, () => undefined);
    return task;
  }, [cacheReady, enabledProviders, getOwnershipOwnerHash, persistLocalUsageState, providerKey]);

  const refreshAfterPending = useCallback(async (): Promise<boolean> => {
    if (!cacheReady) return false;
    const generation = providerSelection.current.generation;
    return runFreshScanAfterPending(
      generation,
      () => providerSelection.current.generation,
      refreshes.current.get(generation),
      refresh,
    );
  }, [cacheReady, refresh]);

  useEffect(() => {
    if (!cacheReady) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [cacheReady, refresh]);

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

  const getCodexCumulative = useCallback(() => Object.fromEntries(
    Object.entries(collectorState.current.codexCumulative).map(([key, tokens]) => [key, { ...tokens }]),
  ), []);
  const getCodexRetiredSessionFilter = useCallback(
    () => collectorState.current.codexRetiredSessionFilter,
    [],
  );

  return {
    events,
    allEvents: collectedEvents,
    cacheReady,
    integrations,
    syncing,
    updatedAt,
    error,
    refresh,
    refreshAfterPending,
    inferredProjectNames,
    projectNames,
    projectNameOverrides,
    updateProjectName,
    getCodexCumulative,
    getCodexRetiredSessionFilter,
  };
}
