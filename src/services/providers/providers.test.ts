// 공급사 어댑터의 인증 헤더와 사용량 정규화를 검증하는 테스트
import { describe, expect, it, vi } from "vitest";
import { AnthropicUsageAdapter } from "./anthropic";
import { GoogleCloudBillingAdapter } from "./google-cloud";
import { OpenAIUsageAdapter } from "./openai";

const query = { startTime: new Date("2026-07-01T00:00:00Z"), endTime: new Date("2026-07-02T00:00:00Z") };

describe("공급사 사용량 어댑터", () => {
  it("OpenAI 토큰을 프로젝트와 모델별로 정규화한다", async () => {
    const request = vi.fn().mockResolvedValue(json({
      data: [{ start_time: 1782864000, results: [{ project_id: "p1", model: "gpt-5", input_tokens: 12, input_cached_tokens: 3, output_tokens: 4 }] }],
    }));
    const result = await new OpenAIUsageAdapter(request).fetchUsage({ adminApiKey: "secret" }, query);
    expect(result[0]).toEqual(expect.objectContaining({ kind: "tokens", projectRef: "p1", inputTokens: 12, cachedTokens: 3 }));
    expect(new Headers(request.mock.calls[0][1].headers).get("Authorization")).toBe("Bearer secret");
  });

  it("Anthropic 캐시 생성과 읽기 토큰을 합산한다", async () => {
    const request = vi.fn().mockResolvedValue(json({ data: [{ starting_at: "2026-07-01T00:00:00Z", usage: { input_tokens: 7, cache_creation_input_tokens: 2, cache_read_input_tokens: 5, output_tokens: 3 } }] }));
    const result = await new AnthropicUsageAdapter(request).fetchUsage({ adminApiKey: "admin" }, query);
    expect(result[0]).toEqual(expect.objectContaining({ inputTokens: 7, cachedTokens: 7, outputTokens: 3 }));
  });

  it("Google Billing 비용 행을 토큰과 분리한다", async () => {
    const request = vi.fn().mockResolvedValue(json({
      jobComplete: true,
      schema: { fields: [{ name: "usage_day" }, { name: "project_id" }, { name: "currency" }, { name: "amount" }] },
      rows: [{ f: [{ v: "2026-07-01" }, { v: "gcp-project" }, { v: "USD" }, { v: "1.25" }] }],
    }));
    const result = await new GoogleCloudBillingAdapter(request).fetchUsage({
      accessToken: "oauth",
      queryProjectId: "query-project",
      billingTable: "billing.dataset.gcp_billing_export_v1_ABC",
    }, query);
    expect(result[0]).toEqual(expect.objectContaining({ kind: "cost", amount: 1.25, currency: "USD" }));
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
