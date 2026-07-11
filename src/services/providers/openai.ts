// OpenAI 조직 사용량 API를 읽는 로컬 자격 증명 어댑터
import type { ProviderUsageAdapter, ProviderUsageRecord, UsageQuery } from "../types";
import { fetchJson } from "./http";

export interface OpenAICredentials {
  adminApiKey: string;
  organizationId?: string;
}

interface UsagePage {
  data?: Array<{ start_time?: number; results?: Array<Record<string, unknown>> }>;
  next_page?: string | null;
}

export class OpenAIUsageAdapter implements ProviderUsageAdapter<OpenAICredentials> {
  readonly provider = "openai" as const;

  constructor(private readonly request: typeof fetch = fetch) {}

  async fetchUsage(credentials: OpenAICredentials, query: UsageQuery): Promise<ProviderUsageRecord[]> {
    const records: ProviderUsageRecord[] = [];
    let page: string | undefined;
    do {
      const url = new URL("https://api.openai.com/v1/organization/usage/completions");
      url.searchParams.set("start_time", unix(query.startTime));
      url.searchParams.set("end_time", unix(query.endTime));
      url.searchParams.set("bucket_width", "1d");
      url.searchParams.append("group_by", "project_id");
      url.searchParams.append("group_by", "model");
      if (page) url.searchParams.set("page", page);
      const response = await fetchJson<UsagePage>(this.provider, this.request, url.toString(), {
        headers: headers(credentials),
      });
      for (const bucket of response.data ?? []) {
        for (const result of bucket.results ?? []) records.push(toRecord(bucket.start_time, result));
      }
      page = response.next_page ?? undefined;
    } while (page);
    return records;
  }
}

function headers(credentials: OpenAICredentials): HeadersInit {
  return {
    Authorization: `Bearer ${credentials.adminApiKey}`,
    ...(credentials.organizationId ? { "OpenAI-Organization": credentials.organizationId } : {}),
  };
}

function toRecord(startTime: number | undefined, value: Record<string, unknown>): ProviderUsageRecord {
  return {
    provider: "openai",
    kind: "tokens",
    occurredAt: new Date((startTime ?? 0) * 1000).toISOString(),
    projectRef: stringValue(value.project_id),
    model: stringValue(value.model),
    inputTokens: numberValue(value.input_tokens),
    cachedTokens: numberValue(value.input_cached_tokens),
    outputTokens: numberValue(value.output_tokens),
    raw: value,
  };
}

function unix(value: Date): string { return Math.floor(value.getTime() / 1000).toString(); }
function numberValue(value: unknown): number { return typeof value === "number" ? value : 0; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
