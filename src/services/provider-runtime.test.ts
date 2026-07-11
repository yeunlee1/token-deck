// 공급사 자격 증명 검증과 사용량 이벤트의 안정적인 변환을 검증하는 테스트
import { describe, expect, it } from "vitest";
import { ACCOUNT_PROVIDER_DEVICE_ID, fetchStoredProviderUsage, parseProviderCredentials, providerRecordsToUsageEvents } from "./provider-runtime";

describe("provider runtime", () => {
  it("공급사별 필수 자격 증명 필드를 검증한다", () => {
    expect(parseProviderCredentials("openai", JSON.stringify({ adminApiKey: "key" }))).toEqual({ adminApiKey: "key" });
    expect(() => parseProviderCredentials("google", JSON.stringify({ accessToken: "token" }))).toThrow("필수 항목");
  });

  it("동일 사용량 레코드는 조회를 반복해도 같은 이벤트 ID를 만든다", () => {
    const record = { provider: "openai" as const, kind: "tokens" as const, occurredAt: "2026-07-11T00:00:00.000Z", projectRef: "project-1", inputTokens: 10, outputTokens: 3, raw: {} };
    const first = providerRecordsToUsageEvents([record], "device-1")[0];
    const second = providerRecordsToUsageEvents([record], "device-1")[0];
    expect(first.eventId).toBe(second.eventId);
    expect(first).toEqual(expect.objectContaining({ source: "provider_api", deviceId: ACCOUNT_PROVIDER_DEVICE_ID, projectId: "project-1", inputTokens: 10, outputTokens: 3 }));
  });

  it("같은 일별 버킷의 누적값이 바뀌어도 기존 이벤트를 갱신한다", () => {
    const first = providerRecordsToUsageEvents([{
      provider: "openai", kind: "tokens", occurredAt: "2026-07-11T00:00:00.000Z",
      projectRef: "project-1", model: "gpt-5", inputTokens: 100, outputTokens: 10, raw: {},
    }], "device-1")[0];
    const corrected = providerRecordsToUsageEvents([{
      provider: "openai", kind: "tokens", occurredAt: "2026-07-11T00:00:00.000Z",
      projectRef: "project-1", model: "gpt-5", inputTokens: 150, outputTokens: 20, raw: {},
    }], "device-2")[0];

    expect(corrected.eventId).toBe(first.eventId);
  });

  it("저장된 자격 증명과 주입된 HTTP 클라이언트로 공급사 사용량을 조회한다", async () => {
    const request = async () => new Response(JSON.stringify({ data: [{ start_time: 1783728000, results: [{ project_id: "p1", input_tokens: 7, output_tokens: 2 }] }] }), { status: 200 });
    const records = await fetchStoredProviderUsage(
      "openai",
      { startTime: new Date("2026-07-10T00:00:00Z"), endTime: new Date("2026-07-11T00:00:00Z") },
      async () => JSON.stringify({ adminApiKey: "secret" }),
      request as typeof fetch,
    );
    expect(records).toEqual([expect.objectContaining({ provider: "openai", projectRef: "p1", inputTokens: 7, outputTokens: 2 })]);
  });
});
