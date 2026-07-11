// 로컬 이벤트 변환 시 토큰 보존과 민감 정보 배제를 검증하는 테스트
import { describe, expect, it } from "vitest";
import type { UsageEvent as CollectorUsageEvent } from "../core/types";
import { mergeCollectorUsageEvents, mergeSessionTitles, mergeUsageWithProviderAuthority, toSyncUsageEvent } from "./core-adapter";

describe("toSyncUsageEvent", () => {
  it.each([
    ["local-jsonl", "local_session"],
    ["otel", "local_session"],
    ["provider-api", "provider_api"],
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

  it("로컬과 다른 기기 이벤트를 ID 기준으로 합치고 로컬 값을 우선한다", () => {
    const remoteDuplicate = { ...localEvent("local-jsonl"), deviceId: "remote-device", tokens: { input: 1, cached: 0, output: 0, reasoning: 0, tool: 0 } };
    const remoteOnly = { ...localEvent("local-jsonl"), id: "event-2", deviceId: "remote-device" };

    const result = mergeCollectorUsageEvents([localEvent("local-jsonl")], [remoteDuplicate, remoteOnly]);

    expect(result).toHaveLength(2);
    expect(result.find((event) => event.id === "event-1")?.deviceId).toBe("device-1");
    expect(result.find((event) => event.id === "event-2")?.deviceId).toBe("remote-device");
  });

  it("다른 기기의 세션 제목을 기존 제목 맵에 병합한다", () => {
    const synced = toSyncUsageEvent(localEvent("local-jsonl"));
    expect(mergeSessionTitles({ old: "기존 제목" }, [{ ...synced, sessionTitle: "원격 제목" }])).toEqual({ old: "기존 제목", "session-1": "원격 제목" });
  });

  it("공급사 API 사용량이 있으면 같은 공급사의 로컬 로그를 중복 합산하지 않는다", () => {
    const localClaude = localEvent("local-jsonl");
    const providerClaude = { ...localEvent("provider-api"), id: "provider-event", tokens: { input: 100, cached: 0, output: 20, reasoning: 0, tool: 0 } };
    const localCodex = { ...localEvent("local-jsonl"), id: "codex-event", provider: "codex" as const };

    expect(mergeUsageWithProviderAuthority([localClaude, localCodex], [providerClaude])).toEqual([providerClaude, localCodex]);
  });

  it("원격 세션 제목이 같으면 기존 참조를 유지해 자동 동기화 루프를 막는다", () => {
    const current = { "session-1": "같은 제목" };
    const synced = { ...toSyncUsageEvent(localEvent("local-jsonl")), sessionTitle: "같은 제목" };
    expect(mergeSessionTitles(current, [synced])).toBe(current);
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
