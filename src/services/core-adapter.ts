// 로컬 수집기 이벤트를 클라우드 동기화 이벤트로 변환하는 어댑터
import type { UsageEvent as CollectorUsageEvent } from "../core/types";
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
    sessionId: event.sessionId,
    projectId: event.projectId,
    model: event.model,
    occurredAt: event.occurredAt,
    inputTokens: event.tokens.input,
    cachedTokens: event.tokens.cached,
    outputTokens: event.tokens.output,
    reasoningTokens: event.tokens.reasoning,
    toolTokens: event.tokens.tool,
    ...(event.requestId ? { metadata: { requestId: event.requestId } } : {}),
  };
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
  const localSessionEvents = mergeCollectorUsageEvents(localSessions, syncedSessions);
  return {
    localSessionEvents,
    accountProviderEvents,
    combinedEvents: localSessionEvents,
  };
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
