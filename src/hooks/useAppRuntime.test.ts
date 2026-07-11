// 동기화된 계정 API 토큰과 비용이 재시작 후에도 설정 요약에 복원되는지 검증하는 테스트
import { describe, expect, it } from "vitest";
import type { UsageEvent } from "../services";
import { mergeAccountProviderUsage } from "./useAppRuntime";

describe("account provider usage summary", () => {
  it("원격 토큰·비용을 복원하고 현재 조회값으로 같은 버킷을 갱신한다", () => {
    const token = syncEvent({ eventId: "provider_openai_deadbeef", provider: "openai", source: "provider_api", inputTokens: 10 });
    const corrected = { provider: "openai" as const, kind: "tokens" as const, occurredAt: token.occurredAt, projectRef: token.projectId, inputTokens: 20, raw: {} };
    const cost = syncEvent({ eventId: "provider_google_cost", provider: "google", source: "cloud_billing", metadata: { amount: 1.25, currency: "USD" } });

    const result = mergeAccountProviderUsage([token, cost], [corrected]);

    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "openai", inputTokens: 20 }),
      expect.objectContaining({ provider: "google", kind: "cost", amount: 1.25, currency: "USD" }),
    ]));
    expect(result).toHaveLength(2);
  });
});

function syncEvent(overrides: Partial<UsageEvent>): UsageEvent {
  return {
    eventId: "event-1", provider: "openai", source: "provider_api",
    deviceId: "00000000-0000-4000-8000-000000000001", projectId: "project-1",
    occurredAt: "2026-07-11T00:00:00.000Z", inputTokens: 0, cachedTokens: 0,
    outputTokens: 0, reasoningTokens: 0, toolTokens: 0, ...overrides,
  };
}
