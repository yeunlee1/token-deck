// 로컬 이벤트 변환 시 토큰 보존과 민감 정보 배제를 검증하는 테스트
import { describe, expect, it } from "vitest";
import type { UsageEvent as CollectorUsageEvent } from "../core/types";
import { toSyncUsageEvent } from "./core-adapter";

describe("toSyncUsageEvent", () => {
  it.each([
    ["local-jsonl", "local_session"],
    ["otel", "local_session"],
  ] as const)("%s 출처를 %s로 매핑하고 토큰 필드를 평탄화한다", (source, expectedSource) => {
    const result = toSyncUsageEvent(localEvent(source));

    expect(result).toEqual({
      eventId: "event-1",
      provider: "claude",
      source: expectedSource,
      deviceId: "device-1",
      sessionId: "session-1",
      projectId: "project-1",
      model: "claude-opus",
      occurredAt: "2026-07-11T00:00:00.000Z",
      inputTokens: 11,
      cachedTokens: 3,
      outputTokens: 5,
      reasoningTokens: 2,
      toolTokens: 1,
      metadata: { requestId: "request-1" },
    });
  });

  it("프롬프트와 로컬 경로 필드를 생성하지 않는다", () => {
    const result = toSyncUsageEvent(localEvent("local-jsonl"));
    const serialized = JSON.stringify(result).toLowerCase();

    expect(Object.keys(result)).not.toContain("prompt");
    expect(Object.keys(result)).not.toContain("path");
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("localpath");
  });
});

function localEvent(source: CollectorUsageEvent["source"]): CollectorUsageEvent {
  return {
    id: "event-1",
    provider: "claude",
    source,
    deviceId: "device-1",
    sessionId: "session-1",
    projectId: "project-1",
    model: "claude-opus",
    occurredAt: "2026-07-11T00:00:00.000Z",
    requestId: "request-1",
    tokens: { input: 11, cached: 3, output: 5, reasoning: 2, tool: 1 },
  };
}
