// 로컬 수집기 이벤트를 클라우드 동기화 이벤트로 변환하는 어댑터
import type { UsageEvent as CollectorUsageEvent } from "../core/types";
import type { UsageEvent as SyncUsageEvent, UsageSource } from "./types";

const SOURCE_MAP: Record<CollectorUsageEvent["source"], UsageSource> = {
  "local-jsonl": "local_session",
  otel: "local_session",
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
