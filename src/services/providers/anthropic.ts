// Anthropic Admin API의 메시지 사용량을 읽는 로컬 자격 증명 어댑터
import type { ProviderUsageAdapter, ProviderUsageRecord, UsageQuery } from "../types";
import { fetchJson } from "./http";

export interface AnthropicCredentials {
  adminApiKey: string;
}

interface UsagePage {
  data?: Array<{ starting_at?: string; results?: Array<Record<string, unknown>> }>;
  has_more?: boolean;
  next_page?: string | null;
}

export class AnthropicUsageAdapter implements ProviderUsageAdapter<AnthropicCredentials> {
  readonly provider = "anthropic" as const;

  constructor(private readonly request: typeof fetch = fetch) {}

  async fetchUsage(credentials: AnthropicCredentials, query: UsageQuery): Promise<ProviderUsageRecord[]> {
    const records: ProviderUsageRecord[] = [];
    let page: string | undefined;
    do {
      const url = new URL("https://api.anthropic.com/v1/organizations/usage_report/messages");
      url.searchParams.set("starting_at", query.startTime.toISOString());
      url.searchParams.set("ending_at", query.endTime.toISOString());
      url.searchParams.set("bucket_width", "1d");
      url.searchParams.append("group_by[]", "workspace_id");
      url.searchParams.append("group_by[]", "model");
      if (page) url.searchParams.set("page", page);
      const response = await fetchJson<UsagePage>(this.provider, this.request, url.toString(), {
        headers: {
          "x-api-key": credentials.adminApiKey,
          "anthropic-version": "2023-06-01",
        },
      });
      for (const bucket of response.data ?? []) {
        for (const result of bucket.results ?? []) records.push(toRecord(bucket.starting_at, result));
      }
      page = response.has_more ? response.next_page ?? undefined : undefined;
    } while (page);
    return records;
  }
}

function toRecord(startingAt: string | undefined, value: Record<string, unknown>): ProviderUsageRecord {
  const usage = objectValue(value.usage);
  const cacheCreation = objectValue(value.cache_creation);
  return {
    provider: "anthropic",
    kind: "tokens",
    occurredAt: startingAt ?? new Date(0).toISOString(),
    projectRef: stringValue(value.workspace_id),
    model: stringValue(value.model),
    inputTokens: numberValue(value.uncached_input_tokens) + numberValue(usage.input_tokens),
    cachedTokens: numberValue(value.cache_read_input_tokens)
      + numberValue(cacheCreation.ephemeral_1h_input_tokens)
      + numberValue(cacheCreation.ephemeral_5m_input_tokens)
      + numberValue(usage.cache_read_input_tokens)
      + numberValue(usage.cache_creation_input_tokens),
    outputTokens: numberValue(value.output_tokens) + numberValue(usage.output_tokens),
    raw: value,
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
function numberValue(value: unknown): number { return typeof value === "number" ? value : 0; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
