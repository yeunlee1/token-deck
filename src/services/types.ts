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
