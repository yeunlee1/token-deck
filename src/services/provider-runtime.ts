// 저장된 공급사 자격 증명으로 사용량을 조회하고 동기화 이벤트로 변환하는 서비스
import { loadProviderSecret, type CredentialProvider } from "./credential-store";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { AnthropicUsageAdapter, type AnthropicCredentials } from "./providers/anthropic";
import { GoogleCloudBillingAdapter, type GoogleCloudCredentials } from "./providers/google-cloud";
import { OpenAIUsageAdapter, type OpenAICredentials } from "./providers/openai";
import type { ProviderUsageRecord, UsageEvent, UsageQuery } from "./types";

export type ProviderCredentials = OpenAICredentials | AnthropicCredentials | GoogleCloudCredentials;

export function parseProviderCredentials(provider: CredentialProvider, value: string): ProviderCredentials {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${provider} 자격 증명 형식이 올바르지 않습니다.`); }
  if (!parsed || typeof parsed !== "object") throw new Error(`${provider} 자격 증명이 비어 있습니다.`);
  const item = parsed as Record<string, unknown>;
  if (provider === "openai" && typeof item.adminApiKey === "string") return item as unknown as OpenAICredentials;
  if (provider === "anthropic" && typeof item.adminApiKey === "string") return item as unknown as AnthropicCredentials;
  if (provider === "google" && typeof item.accessToken === "string" && typeof item.queryProjectId === "string" && typeof item.billingTable === "string") return item as unknown as GoogleCloudCredentials;
  throw new Error(`${provider} 자격 증명의 필수 항목이 없습니다.`);
}

export async function fetchStoredProviderUsage(
  provider: CredentialProvider,
  query: UsageQuery,
  secretLoader: typeof loadProviderSecret = loadProviderSecret,
  request: typeof fetch = providerFetch(),
): Promise<ProviderUsageRecord[]> {
  const secret = await secretLoader(provider);
  if (!secret) throw new Error(`${provider} 자격 증명이 저장되어 있지 않습니다.`);
  const credentials = parseProviderCredentials(provider, secret);
  if (provider === "openai") return new OpenAIUsageAdapter(request).fetchUsage(credentials as OpenAICredentials, query);
  if (provider === "anthropic") return new AnthropicUsageAdapter(request).fetchUsage(credentials as AnthropicCredentials, query);
  return new GoogleCloudBillingAdapter(request).fetchUsage(credentials as GoogleCloudCredentials, query);
}

export function providerRecordsToUsageEvents(records: ProviderUsageRecord[], deviceId: string): UsageEvent[] {
  return records.map((record) => ({
    eventId: providerEventId(record),
    provider: record.provider,
    source: record.kind === "cost" ? "cloud_billing" : "provider_api",
    deviceId,
    projectId: record.projectRef,
    model: record.model,
    occurredAt: record.occurredAt,
    inputTokens: record.inputTokens ?? 0,
    cachedTokens: record.cachedTokens ?? 0,
    outputTokens: record.outputTokens ?? 0,
    reasoningTokens: 0,
    toolTokens: 0,
    metadata: {
      ...(record.amount !== undefined ? { amount: record.amount } : {}),
      ...(record.currency ? { currency: record.currency } : {}),
    },
  }));
}

function providerEventId(record: ProviderUsageRecord): string {
  const value = [record.provider, record.kind, record.occurredAt, record.projectRef ?? "", record.model ?? "", record.inputTokens ?? 0, record.cachedTokens ?? 0, record.outputTokens ?? 0, record.amount ?? 0, record.currency ?? ""].join("|");
  let hash = 2166136261;
  for (let offset = 0; offset < value.length; offset += 1) hash = Math.imul(hash ^ value.charCodeAt(offset), 16777619);
  return `provider_${record.provider}_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function providerFetch(): typeof fetch {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window ? tauriFetch : fetch;
}
