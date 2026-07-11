// 미니 모드의 공급사 선택과 최근 7일 토큰 합계를 검증한다
import { describe, expect, it } from "vitest";
import type { Provider, UsageEvent } from "../core";
import { buildProviderWindowUsage } from "../core";

const now = new Date("2026-07-11T12:00:00.000Z");

describe("buildMiniUsage", () => {
  it("선택한 Codex와 Claude의 5시간과 주간 토큰을 각각 합산한다", () => {
    const result = buildProviderWindowUsage([event("codex", 10), event("claude", 20), event("gemini", 30)], ["codex", "claude"], now);
    expect(result).toEqual([
      { provider: "codex", fiveHours: 10, week: 10, fiveHourEvents: 1, weekEvents: 1 },
      { provider: "claude", fiveHours: 20, week: 20, fiveHourEvents: 1, weekEvents: 1 },
    ]);
  });

  it("5시간 이전 이벤트는 주간에만 포함하고 7일 이전 이벤트는 제외한다", () => {
    const yesterday = { ...event("gemini", 20), id: "yesterday", occurredAt: "2026-07-10T10:00:00.000Z" };
    const old = { ...event("gemini", 99), id: "old", occurredAt: "2026-07-01T12:00:00.000Z" };
    expect(buildProviderWindowUsage([event("gemini", 30), yesterday, old], ["gemini"], now)).toEqual([{ provider: "gemini", fiveHours: 30, week: 50, fiveHourEvents: 1, weekEvents: 2 }]);
  });
});

function event(provider: Provider, input: number): UsageEvent {
  return {
    id: `${provider}-${input}`,
    provider,
    source: "local-jsonl",
    deviceId: "device-1",
    sessionId: "session-1",
    projectId: "project-1",
    occurredAt: "2026-07-11T10:00:00.000Z",
    tokens: { input, cached: 0, output: 0, reasoning: 0, tool: 0 },
  };
}
