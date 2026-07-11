// 기간별 차트 집계가 실제 이벤트와 날짜 경계를 정확히 반영하는지 검증한다
import { describe, expect, it } from "vitest";
import type { UsageEvent } from "../core";
import { buildUsageChart } from "./chart-data";

function usage(provider: UsageEvent["provider"], occurredAt: string, total: number): UsageEvent {
  return {
    id: `${provider}-${occurredAt}`,
    provider,
    source: "local-jsonl",
    deviceId: "device",
    sessionId: "session",
    projectId: "project",
    occurredAt,
    tokens: { input: total, cached: 0, output: 0, reasoning: 0, tool: 0 },
  };
}

describe("buildUsageChart", () => {
  const now = new Date(2026, 6, 11, 18, 30);

  it("오늘 이벤트를 3시간 단위 공급사 시리즈로 집계한다", () => {
    const points = buildUsageChart([
      usage("codex", new Date(2026, 6, 11, 1).toISOString(), 120),
      usage("claude", new Date(2026, 6, 11, 4).toISOString(), 80),
      usage("gemini", new Date(2026, 6, 10, 23).toISOString(), 999),
    ], "오늘", now);

    expect(points).toHaveLength(8);
    expect(points[0]).toMatchObject({ codex: 120, claude: 0 });
    expect(points[1]).toMatchObject({ codex: 0, claude: 80 });
    expect(points.reduce((sum, point) => sum + point.gemini, 0)).toBe(0);
  });

  it("최근 7일을 날짜별로 집계하고 범위 밖 이벤트를 제외한다", () => {
    const points = buildUsageChart([
      usage("codex", new Date(2026, 6, 5, 12).toISOString(), 100),
      usage("codex", new Date(2026, 6, 11, 12).toISOString(), 300),
      usage("claude", new Date(2026, 6, 4, 12).toISOString(), 500),
    ], "7일", now);

    expect(points).toHaveLength(7);
    expect(points.reduce((sum, point) => sum + point.codex, 0)).toBe(400);
    expect(points.reduce((sum, point) => sum + point.claude, 0)).toBe(0);
  });

  it("최근 30일을 5일 단위 여섯 구간으로 집계한다", () => {
    const points = buildUsageChart([
      usage("gemini", new Date(2026, 5, 12, 1).toISOString(), 50),
      usage("gemini", new Date(2026, 6, 11, 1).toISOString(), 75),
    ], "30일", now);

    expect(points).toHaveLength(6);
    expect(points[0].gemini).toBe(50);
    expect(points[5].gemini).toBe(75);
  });
});
