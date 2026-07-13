// 로컬 수집기 이벤트를 클라우드 동기화 이벤트로 변환하는 어댑터
import type { UsageEvent as CollectorUsageEvent } from "../core/types";
import { stableId } from "../core/parse-utils";
import type { UsageEvent as SyncUsageEvent, UsageSource } from "./types";

const SOURCE_MAP: Record<CollectorUsageEvent["source"], UsageSource> = {
  "local-jsonl": "local_session",
  otel: "local_session",
  "provider-api": "provider_api",
};

export function toSyncUsageEvent(event: CollectorUsageEvent): SyncUsageEvent {
  return {
    eventId: event.id,
    provider: event.provider,
    source: SOURCE_MAP[event.source],
    deviceId: event.deviceId,
    sessionId: event.sessionId ? stableId("sync-session", event.deviceId, event.provider, event.sessionId) : undefined,
    projectId: event.projectId ? toSyncProjectId(event.projectId) : undefined,
    model: event.model,
    occurredAt: event.occurredAt,
    inputTokens: event.tokens.input,
    cachedTokens: event.tokens.cached,
    outputTokens: event.tokens.output,
    reasoningTokens: event.tokens.reasoning,
    toolTokens: event.tokens.tool,
  };
}

const SAFE_PROJECT_ID = /^(?:git|local|provider|project)_[0-9a-f]{64}$/;
const CANONICAL_PROJECT_ID = /^(?:git|local|provider)_[0-9a-f]{64}$/;
const LOCAL_PROVIDERS: CollectorUsageEvent["provider"][] = ["codex", "claude", "gemini"];

/** 이미 익명화된 프로젝트 ID는 보존하고 그 밖의 값만 공급사와 무관하게 익명화합니다. */
export function toSyncProjectId(projectId: string): string {
  const normalized = projectId.trim();
  return SAFE_PROJECT_ID.test(normalized)
    ? normalized
    : `project_${stableId("sync-project", normalized)}`;
}

export function toSyncUsageEvents(events: CollectorUsageEvent[]): SyncUsageEvent[] {
  return events.map(toSyncUsageEvent);
}

export function mergeCollectorUsageEvents(local: CollectorUsageEvent[], remote: CollectorUsageEvent[]): CollectorUsageEvent[] {
  const byId = new Map(remote.map((event) => [event.id, event]));
  local.forEach((event) => byId.set(event.id, event));
  return [...byId.values()];
}

export function mergeUsageWithProviderAuthority(local: CollectorUsageEvent[], cloud: CollectorUsageEvent[]): CollectorUsageEvent[] {
  const authoritativeProviders = new Set(cloud.filter((event) => event.source === "provider-api").map((event) => event.provider));
  const localWithoutCloudDuplicates = local.filter((event) => !authoritativeProviders.has(event.provider));
  const cloudWithoutLocalDuplicates = cloud.filter((event) => event.source === "provider-api" || !authoritativeProviders.has(event.provider));
  return mergeCollectorUsageEvents(localWithoutCloudDuplicates, cloudWithoutLocalDuplicates);
}

export interface UsageViews {
  localSessionEvents: CollectorUsageEvent[];
  accountProviderEvents: CollectorUsageEvent[];
  combinedEvents: CollectorUsageEvent[];
}

export function buildUsageViews(local: CollectorUsageEvent[], cloud: CollectorUsageEvent[]): UsageViews {
  const localSessions = local.filter((event) => event.source !== "provider-api");
  const syncedSessions = cloud.filter((event) => event.source !== "provider-api");
  const accountProviderEvents = deduplicateProviderBuckets(cloud.filter((event) => event.source === "provider-api"));
  const localSessionEvents = normalizeLegacyProjectAliases(mergeCollectorUsageEvents(localSessions, syncedSessions));
  return {
    localSessionEvents,
    accountProviderEvents,
    combinedEvents: localSessionEvents,
  };
}

/** 새 정규 ID가 함께 보이는 동안 이전 버전의 공급사별 프로젝트 ID를 화면에서 같은 프로젝트로 묶습니다. */
export function normalizeLegacyProjectAliases(events: CollectorUsageEvent[]): CollectorUsageEvent[] {
  const aliases = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const event of events) {
    if (!CANONICAL_PROJECT_ID.test(event.projectId)) continue;
    for (const provider of LOCAL_PROVIDERS) {
      const legacyId = `project_${stableId("sync-project", provider, event.projectId)}`;
      const current = aliases.get(legacyId);
      if (current && current !== event.projectId) ambiguous.add(legacyId);
      else aliases.set(legacyId, event.projectId);
    }
  }
  ambiguous.forEach((id) => aliases.delete(id));
  return events.map((event) => {
    const canonicalId = aliases.get(event.projectId);
    return canonicalId && canonicalId !== event.projectId ? { ...event, projectId: canonicalId } : event;
  });
}

function deduplicateProviderBuckets(events: CollectorUsageEvent[]): CollectorUsageEvent[] {
  const buckets = new Map<string, CollectorUsageEvent>();
  for (const event of events) {
    const key = [event.provider, event.occurredAt, event.projectId, event.model ?? ""].join("\u001f");
    const current = buckets.get(key);
    if (!current || event.id.length >= current.id.length) buckets.set(key, event);
  }
  return [...buckets.values()];
}

export function mergeSessionTitles(current: Record<string, string>, events: SyncUsageEvent[]): Record<string, string> {
  const merged = { ...current };
  let changed = false;
  events.forEach((event) => {
    if (event.sessionId && event.sessionTitle && merged[event.sessionId] !== event.sessionTitle) {
      merged[event.sessionId] = event.sessionTitle;
      changed = true;
    }
  });
  return changed ? merged : current;
}
