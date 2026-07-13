// 계정의 기기·프로젝트 교차 집계와 양방향 합계 일치를 검증하는 테스트
import { describe, expect, it } from "vitest";
import type { Provider, TokenBreakdown, UsageEvent } from "./types";
import { buildAccountUsageMatrix } from "./account-usage";

describe("buildAccountUsageMatrix", () => {
  it("동일 프로젝트의 두 기기 사용량을 하나의 프로젝트 합계로 묶는다", () => {
    const matrix = buildAccountUsageMatrix([
      event("one", "home", "shared", "codex", { input: 100, cached: 20, output: 30 }),
      event("two", "office", "shared", "claude", { input: 200, output: 50 }),
      event("three", "home", "private", "gemini", { input: 40, output: 10 }),
    ]);

    const shared = matrix.projects.find((project) => project.projectId === "shared");

    expect(shared?.totals).toMatchObject({ totalTokens: 400, requestCount: 2, providerCount: 2 });
    expect(shared?.devices.map((device) => [device.deviceId, device.totalTokens])).toEqual([
      ["office", 250],
      ["home", 150],
    ]);
    expect(matrix.totals).toMatchObject({ totalTokens: 450, requestCount: 3, providerCount: 3 });
  });

  it("기기별 프로젝트 합계와 프로젝트별 기기 합계가 같은 셀과 전체 합계를 사용한다", () => {
    const matrix = buildAccountUsageMatrix([
      event("one", "device-a", "project-a", "codex", { input: 10, cached: 2, output: 3 }),
      event("two", "device-a", "project-b", "claude", { input: 20, output: 5 }),
      event("three", "device-b", "project-a", "gemini", { input: 30, reasoning: 4 }),
      event("four", "device-b", "project-b", "codex", { input: 40, tool: 6 }),
    ]);

    const deviceTokenSum = matrix.devices.reduce((sum, device) => sum + device.totals.totalTokens, 0);
    const projectTokenSum = matrix.projects.reduce((sum, project) => sum + project.totals.totalTokens, 0);
    const deviceRequestSum = matrix.devices.reduce((sum, device) => sum + device.totals.requestCount, 0);
    const projectRequestSum = matrix.projects.reduce((sum, project) => sum + project.totals.requestCount, 0);

    expect(deviceTokenSum).toBe(matrix.totals.totalTokens);
    expect(projectTokenSum).toBe(matrix.totals.totalTokens);
    expect(deviceRequestSum).toBe(matrix.totals.requestCount);
    expect(projectRequestSum).toBe(matrix.totals.requestCount);

    for (const device of matrix.devices) {
      for (const cell of device.projects) {
        const reverse = matrix.projects
          .find((project) => project.projectId === cell.projectId)
          ?.devices.find((candidate) => candidate.deviceId === device.deviceId);
        expect(reverse).toBe(cell);
      }
    }
  });

  it("중복 이벤트 ID를 계정 요청과 토큰에 두 번 합산하지 않는다", () => {
    const duplicate = event("same", "device", "project", "codex", { input: 10, output: 5 });
    const matrix = buildAccountUsageMatrix([duplicate, duplicate]);

    expect(matrix.totals).toMatchObject({ totalTokens: 15, requestCount: 1, providerCount: 1 });
    expect(matrix.totals.byProvider.codex).toMatchObject({ totalTokens: 15, requestCount: 1 });
    expect(matrix.totals.byProvider.claude).toMatchObject({ totalTokens: 0, requestCount: 0 });
  });
});

function event(
  id: string,
  deviceId: string,
  projectId: string,
  provider: Provider,
  partialTokens: Partial<TokenBreakdown>,
): UsageEvent {
  return {
    id,
    deviceId,
    projectId,
    provider,
    source: "local-jsonl",
    sessionId: `session-${id}`,
    occurredAt: "2026-07-13T00:00:00.000Z",
    tokens: { input: 0, cached: 0, output: 0, reasoning: 0, tool: 0, ...partialTokens },
  };
}
