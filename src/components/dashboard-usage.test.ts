// 프로젝트와 기기 집계가 계정 전체 API 사용량을 물리적 기기에 귀속하지 않는지 검증한다
import { describe, expect, it } from "vitest";
import type { UsageEvent } from "../core";
import { selectProjectDeviceEvents } from "./dashboard-usage";

describe("selectProjectDeviceEvents", () => {
  it("같은 공급사와 기기 ID여도 provider API 이벤트는 제외한다", () => {
    const local = event("local", "local-jsonl", "device-1", "project-local");
    const remote = event("remote", "local-jsonl", "device-2", "project-remote");
    const accountApi = event("account", "provider-api", "device-1", "api-project");

    expect(selectProjectDeviceEvents([local, remote, accountApi], ["codex"], new Date("2026-07-01T00:00:00Z")))
      .toEqual([local, remote]);
  });
});

function event(id: string, source: UsageEvent["source"], deviceId: string, projectId: string): UsageEvent {
  return {
    id,
    provider: "codex",
    source,
    deviceId,
    projectId,
    sessionId: `session-${id}`,
    occurredAt: "2026-07-12T00:00:00Z",
    tokens: { input: 100, cached: 0, output: 0, reasoning: 0, tool: 0 },
  };
}
