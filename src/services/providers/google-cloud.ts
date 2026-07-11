// BigQuery Billing Export를 조회하는 Google Cloud 비용 어댑터
import type { ProviderUsageAdapter, ProviderUsageRecord, UsageQuery } from "../types";
import { fetchJson } from "./http";

export interface GoogleCloudCredentials {
  accessToken: string;
  queryProjectId: string;
  billingTable: string;
  location?: string;
  maximumBytesBilled?: string;
}

interface QueryResponse {
  jobComplete?: boolean;
  schema?: { fields?: Array<{ name?: string }> };
  rows?: Array<{ f?: Array<{ v?: unknown }> }>;
}

export class GoogleCloudBillingAdapter implements ProviderUsageAdapter<GoogleCloudCredentials> {
  readonly provider = "google" as const;

  constructor(private readonly request: typeof fetch = fetch) {}

  async fetchUsage(credentials: GoogleCloudCredentials, query: UsageQuery): Promise<ProviderUsageRecord[]> {
    validateTable(credentials.billingTable);
    const endpoint = `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(credentials.queryProjectId)}/queries`;
    const response = await fetchJson<QueryResponse>(this.provider, this.request, endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: billingQuery(credentials.billingTable, query.projectRefs?.length ?? 0),
        useLegacySql: false,
        location: credentials.location,
        maximumBytesBilled: credentials.maximumBytesBilled,
        parameterMode: "NAMED",
        queryParameters: queryParameters(query),
      }),
    });
    if (response.jobComplete === false) throw new Error("BigQuery 비용 쿼리가 제한 시간 안에 완료되지 않았습니다.");
    return rowsToRecords(response);
  }
}

function billingQuery(table: string, projectCount: number): string {
  return `SELECT DATE(usage_start_time) AS usage_day, project.id AS project_id, currency, SUM(cost) AS amount
FROM \`${table}\`
WHERE usage_start_time >= @start_time AND usage_start_time < @end_time
${projectCount ? "AND project.id IN UNNEST(@project_ids)" : ""}
GROUP BY usage_day, project_id, currency
ORDER BY usage_day`;
}

function queryParameters(query: UsageQuery): unknown[] {
  const params: unknown[] = [
    scalar("start_time", "TIMESTAMP", query.startTime.toISOString()),
    scalar("end_time", "TIMESTAMP", query.endTime.toISOString()),
  ];
  if (query.projectRefs?.length) {
    params.push({
      name: "project_ids",
      parameterType: { type: "ARRAY", arrayType: { type: "STRING" } },
      parameterValue: { arrayValues: query.projectRefs.map((value) => ({ value })) },
    });
  }
  return params;
}

function scalar(name: string, type: string, value: string): unknown {
  return { name, parameterType: { type }, parameterValue: { value } };
}

function rowsToRecords(response: QueryResponse): ProviderUsageRecord[] {
  const fields = response.schema?.fields?.map((field) => field.name ?? "") ?? [];
  return (response.rows ?? []).map((row) => {
    const values = Object.fromEntries(fields.map((name, index) => [name, row.f?.[index]?.v]));
    return {
      provider: "google" as const,
      kind: "cost" as const,
      occurredAt: `${String(values.usage_day)}T00:00:00.000Z`,
      projectRef: typeof values.project_id === "string" ? values.project_id : undefined,
      amount: Number(values.amount ?? 0),
      currency: typeof values.currency === "string" ? values.currency : undefined,
      raw: values,
    };
  });
}

function validateTable(value: string): void {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("billingTable은 project.dataset.table 형식이어야 합니다.");
  }
}
