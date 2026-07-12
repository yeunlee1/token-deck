// 공급사와 기기를 아우르는 사용량 동기화 계약
export type Provider = "openai" | "anthropic" | "google" | "codex" | "claude" | "gemini";

export type UsageSource = "local_session" | "provider_api" | "cloud_billing";

export interface UsageEvent {
  eventId: string;
  provider: Provider;
  source: UsageSource;
  deviceId: string;
  sessionId?: string;
  projectId?: string;
  model?: string;
  occurredAt: string;
  createdAt?: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  toolTokens: number;
  sessionTitle?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface DeviceRegistration {
  id: string;
  name: string;
  platform: string;
  appVersion: string;
  lastSeenAt: string;
}

export type DeviceInventoryProvider = "codex" | "claude" | "gemini";

export type DeviceInventoryKind = "skill" | "mcp" | "plugin";

export type DeviceInventorySource = "user" | "system" | "marketplace" | "bundled" | "project";

export type DeviceInventoryTransport = "stdio" | "http" | "sse" | "unknown";

export type DeviceInventoryBlockedReason = "secret" | "local_path" | "unsupported";

/**
 * 기기 간 공유가 허용된 설정 메타데이터입니다.
 * 전체 경로, 명령과 인수 원문, 환경 변수 값, 토큰이나 설정 파일 내용은 의도적으로 표현하지 않습니다.
 */
export interface DeviceInventoryItem {
  provider: DeviceInventoryProvider;
  kind: DeviceInventoryKind;
  key: string;
  displayName: string;
  version?: string;
  enabled: boolean;
  installed: boolean;
  source: DeviceInventorySource;
  marketplace?: string;
  transport?: DeviceInventoryTransport;
  hasSecrets: boolean;
  transferable: boolean;
  blockedReason?: DeviceInventoryBlockedReason;
}

/** 네이티브 수집기가 반환하는 현재 기기의 비밀값 없는 설정 인벤토리입니다. */
export interface DeviceInventory {
  schemaVersion: 1;
  capturedAt: number;
  items: DeviceInventoryItem[];
  /** 원문 오류나 경로가 아닌 고정 경고 코드만 담습니다. */
  warnings: string[];
}

/** 계정 동기화에 저장되는 기기별 원자적 설정 스냅샷입니다. */
export interface DeviceInventorySnapshot {
  deviceId: string;
  schemaVersion: 1;
  capturedAt: number;
  contentHash: string;
  items: DeviceInventoryItem[];
  updatedAt?: number;
}

export interface SyncResult {
  uploaded: number;
  disabled: boolean;
  error?: string;
}

export interface ProviderUsageRecord {
  provider: "openai" | "anthropic" | "google";
  kind: "tokens" | "cost";
  occurredAt: string;
  projectRef?: string;
  model?: string;
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  amount?: number;
  currency?: string;
  raw: unknown;
}

export interface UsageQuery {
  startTime: Date;
  endTime: Date;
  projectRefs?: string[];
}

export interface ProviderUsageAdapter<TCredentials> {
  readonly provider: ProviderUsageRecord["provider"];
  fetchUsage(credentials: TCredentials, query: UsageQuery): Promise<ProviderUsageRecord[]>;
}
