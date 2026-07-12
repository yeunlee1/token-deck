// 기기 등록과 사용 이벤트 멱등 업서트를 담당하는 동기화 서비스
import type {
  DeviceInventory,
  DeviceInventoryBlockedReason,
  DeviceInventoryItem,
  DeviceInventoryKind,
  DeviceInventoryProvider,
  DeviceInventorySnapshot,
  DeviceInventorySource,
  DeviceInventoryTransport,
  DeviceRegistration,
  SyncResult,
  UsageEvent,
} from "../types";
import { SupabaseRequestError, SupabaseRestClient } from "./client";
import { stableId } from "../../core/parse-utils";

const BATCH_SIZE = 500;
const DEVICE_INVENTORY_MAX_ITEMS = 512;
const DEVICE_INVENTORY_MAX_BYTES = 512 * 1024;

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

  async upsertDeviceInventorySnapshot(snapshot: DeviceInventorySnapshot): Promise<SyncResult> {
    if (!this.client.enabled) return { uploaded: 0, disabled: true };
    try {
      await this.client.call("/rest/v1/device_setting_snapshots?on_conflict=user_id,device_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(toDeviceInventoryRow(snapshot)),
      });
      return { uploaded: 1, disabled: false };
    } catch (error) {
      return failed(error);
    }
  }

  async listDeviceInventorySnapshots(): Promise<DeviceInventorySnapshot[]> {
    if (!this.client.enabled) return [];
    const snapshots: DeviceInventorySnapshot[] = [];
    for (let offset = 0; ; offset += 1000) {
      const rows = await this.client.call<Array<Record<string, unknown>>>(
        "/rest/v1/device_setting_snapshots?select=device_id,schema_version,content_hash,captured_at,items,updated_at&order=updated_at.asc,device_id.asc",
        { headers: { Range: `${offset}-${offset + 999}` } },
      );
      snapshots.push(...rows.flatMap((row) => {
        const snapshot = fromDeviceInventoryRow(row);
        return snapshot ? [snapshot] : [];
      }));
      if (rows.length < 1000) break;
    }
    return snapshots;
  }
}

export function createDeviceInventorySnapshot(
  deviceId: string,
  inventory: DeviceInventory,
): DeviceInventorySnapshot {
  const items = inventory.items.map(toSyncedInventoryItem);
  return {
    deviceId,
    schemaVersion: 1,
    capturedAt: inventory.capturedAt,
    contentHash: deviceInventoryContentHash(items),
    items,
  };
}

export function deviceInventoryContentHash(items: DeviceInventoryItem[]): string {
  const canonicalItems = items
    .map(toSyncedInventoryItem)
    .map((item) => [
      item.provider,
      item.kind,
      item.key,
      item.displayName,
      item.version ?? null,
      item.enabled,
      item.installed,
      item.source,
      item.marketplace ?? null,
      item.transport ?? null,
      item.hasSecrets,
      item.transferable,
      item.blockedReason ?? null,
    ] as const)
    .sort((left, right) => {
      const leftValue = JSON.stringify(left);
      const rightValue = JSON.stringify(right);
      return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
    });
  return stableId(JSON.stringify(canonicalItems));
}

export function isDeviceInventoryTableMissingError(error: unknown): boolean {
  const status = error instanceof SupabaseRequestError ? error.status : undefined;
  const body = error instanceof SupabaseRequestError ? error.body : undefined;
  const code = body && typeof body === "object" && "code" in body ? String(body.code) : "";
  const detail = `${error instanceof Error ? error.message : String(error ?? "")} ${safeErrorBody(body)}`.toLowerCase();
  const targetTable = detail.includes("device_setting_snapshots");
  return (code === "PGRST205" || status === 404 || detail.includes("pgrst205"))
    && targetTable
    && (detail.includes("schema cache") || detail.includes("does not exist"));
}

function toDeviceInventoryRow(snapshot: DeviceInventorySnapshot): Record<string, unknown> {
  const capturedAt = new Date(snapshot.capturedAt);
  if (!Number.isFinite(snapshot.capturedAt) || Number.isNaN(capturedAt.getTime())) {
    throw new Error("기기 설정 인벤토리 수집 시간이 올바르지 않습니다.");
  }
  const items = snapshot.items.map(toSyncedInventoryItem);
  if (items.length > DEVICE_INVENTORY_MAX_ITEMS) {
    throw new Error(`기기 설정 인벤토리는 최대 ${DEVICE_INVENTORY_MAX_ITEMS}개 항목까지 동기화할 수 있습니다.`);
  }
  if (new TextEncoder().encode(JSON.stringify(items)).byteLength > DEVICE_INVENTORY_MAX_BYTES) {
    throw new Error("기기 설정 인벤토리 크기가 512 KiB 제한을 초과했습니다.");
  }
  return {
    device_id: snapshot.deviceId,
    schema_version: 1,
    content_hash: deviceInventoryContentHash(items),
    captured_at: capturedAt.toISOString(),
    items,
    updated_at: new Date().toISOString(),
  };
}

function fromDeviceInventoryRow(row: Record<string, unknown>): DeviceInventorySnapshot | undefined {
  if (Number(row.schema_version) !== 1 || typeof row.device_id !== "string" || !Array.isArray(row.items)) return undefined;
  const contentHash = typeof row.content_hash === "string" ? row.content_hash : "";
  if (!/^[0-9a-f]{64}$/.test(contentHash)) return undefined;
  const capturedAt = typeof row.captured_at === "string" ? Date.parse(row.captured_at) : Number.NaN;
  if (!Number.isFinite(capturedAt)) return undefined;
  const items = row.items.map(fromSyncedInventoryItem);
  if (items.some((item) => !item)) return undefined;
  const validItems = items as DeviceInventoryItem[];
  if (deviceInventoryContentHash(validItems) !== contentHash) return undefined;
  const updatedAt = typeof row.updated_at === "string" ? Date.parse(row.updated_at) : Number.NaN;
  return {
    deviceId: row.device_id,
    schemaVersion: 1,
    capturedAt,
    contentHash,
    items: validItems,
    ...(Number.isFinite(updatedAt) ? { updatedAt } : {}),
  };
}

function toSyncedInventoryItem(item: DeviceInventoryItem): DeviceInventoryItem {
  return {
    provider: item.provider,
    kind: item.kind,
    key: item.key,
    displayName: item.displayName,
    ...(typeof item.version === "string" ? { version: item.version } : {}),
    enabled: item.enabled,
    installed: item.installed,
    source: item.source,
    ...(typeof item.marketplace === "string" ? { marketplace: item.marketplace } : {}),
    ...(typeof item.transport === "string" ? { transport: item.transport } : {}),
    hasSecrets: item.hasSecrets,
    transferable: item.transferable,
    ...(typeof item.blockedReason === "string" ? { blockedReason: item.blockedReason } : {}),
  };
}

function fromSyncedInventoryItem(value: unknown): DeviceInventoryItem | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (!isOneOf<DeviceInventoryProvider>(item.provider, ["codex", "claude", "gemini"])) return undefined;
  if (!isOneOf<DeviceInventoryKind>(item.kind, ["skill", "mcp", "plugin"])) return undefined;
  if (!isOneOf<DeviceInventorySource>(item.source, ["user", "system", "marketplace", "bundled", "project"])) return undefined;
  if (typeof item.key !== "string" || typeof item.displayName !== "string") return undefined;
  if (typeof item.enabled !== "boolean" || typeof item.installed !== "boolean") return undefined;
  if (typeof item.hasSecrets !== "boolean" || typeof item.transferable !== "boolean") return undefined;
  if (item.transport !== undefined && !isOneOf<DeviceInventoryTransport>(item.transport, ["stdio", "http", "sse", "unknown"])) return undefined;
  if (item.blockedReason !== undefined && !isOneOf<DeviceInventoryBlockedReason>(item.blockedReason, ["secret", "local_path", "unsupported"])) return undefined;
  if (item.version !== undefined && typeof item.version !== "string") return undefined;
  if (item.marketplace !== undefined && typeof item.marketplace !== "string") return undefined;
  return toSyncedInventoryItem(item as unknown as DeviceInventoryItem);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function safeErrorBody(value: unknown): string {
  try {
    return value === undefined ? "" : JSON.stringify(value);
  } catch {
    return String(value ?? "");
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
