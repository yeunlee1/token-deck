// 기기 등록과 사용 이벤트 멱등 업서트를 담당하는 동기화 서비스
import type { DeviceRegistration, SyncResult, UsageEvent } from "../types";
import { SupabaseRequestError, SupabaseRestClient } from "./client";

const BATCH_SIZE = 500;

export class UsageSyncService {
  constructor(private readonly client: SupabaseRestClient) {}

  async registerDevice(device: DeviceRegistration): Promise<SyncResult> {
    if (!this.client.enabled) return { uploaded: 0, disabled: true };
    try {
      await this.client.call("/rest/v1/devices?on_conflict=id,user_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          id: device.id,
          name: device.name,
          platform: device.platform,
          app_version: device.appVersion,
          last_seen_at: device.lastSeenAt,
        }),
      });
      return { uploaded: 1, disabled: false };
    } catch (error) {
      return failed(error);
    }
  }

  async upsertUsageEvents(events: UsageEvent[]): Promise<SyncResult> {
    if (!this.client.enabled) return { uploaded: 0, disabled: true };
    if (events.length === 0) return { uploaded: 0, disabled: false };

    let uploaded = 0;
    try {
      for (let index = 0; index < events.length; index += BATCH_SIZE) {
        const batch = events.slice(index, index + BATCH_SIZE).map(toRow);
        await this.client.call("/rest/v1/usage_events?on_conflict=user_id,event_id", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(batch),
        });
        uploaded += batch.length;
      }
      return { uploaded, disabled: false };
    } catch (error) {
      return { ...failed(error), uploaded };
    }
  }
}

function toRow(event: UsageEvent): Record<string, unknown> {
  return {
    event_id: event.eventId,
    provider: event.provider,
    source: event.source,
    device_id: event.deviceId,
    session_id: event.sessionId ?? null,
    project_id: event.projectId ?? null,
    model: event.model ?? null,
    occurred_at: event.occurredAt,
    input_tokens: event.inputTokens,
    cached_tokens: event.cachedTokens,
    output_tokens: event.outputTokens,
    reasoning_tokens: event.reasoningTokens,
    tool_tokens: event.toolTokens,
    session_title: event.sessionTitle ?? null,
    metadata: event.metadata ?? {},
  };
}

function failed(error: unknown): SyncResult {
  const message = error instanceof SupabaseRequestError
    ? `${error.message}${error.body ? `: ${JSON.stringify(error.body)}` : ""}`
    : error instanceof Error ? error.message : String(error);
  return { uploaded: 0, disabled: false, error: message };
}
