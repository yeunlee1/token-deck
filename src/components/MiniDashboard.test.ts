// 미니 모드의 공급사 선택과 최근 7일 토큰 합계를 검증한다
import { describe, expect, it } from "vitest";
import type { Provider, UsageEvent } from "../core";
import { buildMiniUsage } from "./MiniDashboard";

const now = new Date("2026-07-11T12:00:00.000Z");

describe("buildMiniUsage", () => {
  it("Codex와 Claude 선택 시 두 공급사만 각각 합산한다", () => {
    const result = buildMiniUsage([event("codex", 10), event("claude", 20), event("gemini", 30)], "codex_claude", now);
    expect(result).toEqual([
      { provider: "codex", total: 10, events: 1 },
      { provider: "claude", total: 20, events: 1 },
    ]);
  });

  it("단독 선택과 7일 이전 이벤트 제외를 적용한다", () => {
    const old = { ...event("gemini", 99), id: "old", occurredAt: "2026-07-01T12:00:00.000Z" };
    expect(buildMiniUsage([event("gemini", 30), old], "gemini", now)).toEqual([{ provider: "gemini", total: 30, events: 1 }]);
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
