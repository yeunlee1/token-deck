// 기기 등록과 사용 이벤트 멱등 업서트를 담당하는 동기화 서비스
import type { DeviceRegistration, SyncResult, UsageEvent } from "../types";
import { SupabaseRequestError, SupabaseRestClient } from "./client";
import { stableId } from "../../core/parse-utils";

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
      await this.upsertReferences(events);
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

  private async upsertReferences(events: UsageEvent[]): Promise<void> {
    const projects = new Map<string, { id: string; name: string; git_remote_hash: string | null; local_project_hash: string | null }>();
    const sessions = new Map<string, { id: string; device_id: string; project_id: string | null; provider: UsageEvent["provider"]; external_id: string; started_at: string; title: string | null }>();
    for (const event of events) {
      if (event.projectId) {
        projects.set(event.projectId, {
          id: event.projectId,
          name: `프로젝트 ${event.projectId.slice(-8)}`,
          git_remote_hash: event.projectId.startsWith("git_") ? event.projectId : null,
          local_project_hash: event.projectId.startsWith("git_") ? null : event.projectId,
        });
      }
      if (event.sessionId) {
        const id = sessionRowId(event);
        const current = sessions.get(id);
        sessions.set(id, {
          id,
          device_id: event.deviceId,
          project_id: event.projectId ?? null,
          provider: event.provider,
          external_id: id,
          started_at: current && current.started_at < event.occurredAt ? current.started_at : event.occurredAt,
          title: event.sessionTitle ?? current?.title ?? null,
        });
      }
    }
    const projectRows = [...projects.values()];
    for (let index = 0; index < projectRows.length; index += BATCH_SIZE) {
      await this.client.call("/rest/v1/projects?on_conflict=user_id,id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(projectRows.slice(index, index + BATCH_SIZE)),
      });
    }
    const sessionRows = [...sessions.values()];
    for (let index = 0; index < sessionRows.length; index += BATCH_SIZE) {
      await this.client.call("/rest/v1/sessions?on_conflict=user_id,id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(sessionRows.slice(index, index + BATCH_SIZE)),
      });
    }
  }

  async listUsageEvents(createdAtOrAfter?: string, excludedDeviceId?: string): Promise<UsageEvent[]> {
    if (!this.client.enabled) return [];
    const events: UsageEvent[] = [];
    const createdAtFilter = createdAtOrAfter ? `&created_at=gte.${encodeURIComponent(createdAtOrAfter)}` : "";
    const deviceFilter = excludedDeviceId ? `&device_id=neq.${encodeURIComponent(excludedDeviceId)}` : "";
    for (let offset = 0; ; offset += 1000) {
      const rows = await this.client.call<Array<Record<string, unknown>>>(
        `/rest/v1/usage_events?select=event_id,provider,source,device_id,session_id,project_id,model,occurred_at,input_tokens,cached_tokens,output_tokens,reasoning_tokens,tool_tokens,session_title,metadata,created_at${createdAtFilter}${deviceFilter}&order=created_at.asc,event_id.asc`,
        { headers: { Range: `${offset}-${offset + 999}` } },
      );
      events.push(...rows.map(fromRow));
      if (rows.length < 1000) break;
    }
    return events;
  }

  async listDevices(): Promise<DeviceRegistration[]> {
    if (!this.client.enabled) return [];
    const rows = await this.client.call<Array<Record<string, unknown>>>(
      "/rest/v1/devices?select=id,name,platform,app_version,last_seen_at&order=last_seen_at.desc",
    );
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      platform: String(row.platform),
      appVersion: String(row.app_version),
      lastSeenAt: String(row.last_seen_at),
    }));
  }
}

function toRow(event: UsageEvent): Record<string, unknown> {
  return {
    event_id: event.eventId,
    provider: event.provider,
    source: event.source,
    device_id: event.deviceId,
    session_id: event.sessionId ? sessionRowId(event) : null,
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

function fromRow(row: Record<string, unknown>): UsageEvent {
  const metadata = objectValue(row.metadata);
  return {
    eventId: String(row.event_id),
    provider: row.provider as UsageEvent["provider"],
    source: row.source as UsageEvent["source"],
    deviceId: String(row.device_id),
    sessionId: stringValue(row.session_id),
    projectId: stringValue(row.project_id),
    model: stringValue(row.model),
    occurredAt: String(row.occurred_at),
    createdAt: stringValue(row.created_at),
    inputTokens: numberValue(row.input_tokens),
    cachedTokens: numberValue(row.cached_tokens),
    outputTokens: numberValue(row.output_tokens),
    reasoningTokens: numberValue(row.reasoning_tokens),
    toolTokens: numberValue(row.tool_tokens),
    sessionTitle: stringValue(row.session_title),
    metadata,
  };
}

function objectValue(value: unknown): Record<string, string | number | boolean | null> {
  return value && typeof value === "object" ? value as Record<string, string | number | boolean | null> : {};
}
function stringValue(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function numberValue(value: unknown): number { return typeof value === "number" ? value : Number(value ?? 0); }
function sessionRowId(event: Pick<UsageEvent, "deviceId" | "provider" | "sessionId">): string {
  return `session_${stableId(event.deviceId, event.provider, event.sessionId)}`;
}

function failed(error: unknown): SyncResult {
  const message = error instanceof SupabaseRequestError
    ? `${error.message}${error.body ? `: ${JSON.stringify(error.body)}` : ""}`
    : error instanceof Error ? error.message : String(error);
  return { uploaded: 0, disabled: false, error: message };
}
