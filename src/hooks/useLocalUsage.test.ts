// 선택한 공급사의 사용 이벤트만 화면과 동기화 계층에 전달하는지 검증한다
import { describe, expect, it } from "vitest";
import type { UsageEvent } from "../core";
import { selectEnabledUsageEvents } from "./useLocalUsage";

function event(provider: UsageEvent["provider"]): UsageEvent {
  return {
    id: provider,
    provider,
    source: "local-jsonl",
    deviceId: "device-1",
    sessionId: `session-${provider}`,
    projectId: "project-1",
    occurredAt: "2026-07-13T00:00:00.000Z",
    tokens: { input: 1, cached: 0, output: 0, reasoning: 0, tool: 0 },
  };
}

describe("enabled provider usage", () => {
  it("내부 기록을 변경하지 않고 선택한 공급사만 반환한다", () => {
    const collected = [event("codex"), event("claude"), event("gemini")];

    expect(selectEnabledUsageEvents(collected, ["codex"]).map((item) => item.provider)).toEqual(["codex"]);
    expect(collected.map((item) => item.provider)).toEqual(["codex", "claude", "gemini"]);
  });
});
