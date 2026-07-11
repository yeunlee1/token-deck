// 로그 문서 오케스트레이션과 공급사·프로젝트 집계를 검증하는 테스트
import { describe, expect, it } from "vitest";

import { aggregateByProject, aggregateByProvider } from "./aggregate";
import { collectUsageDocuments } from "./collect";
import { createCollectorState } from "./types";

describe("usage document orchestration", () => {
  it("derives session and privacy-safe project identity before parsing", () => {
    const content = [
      JSON.stringify({ type: "session_meta", payload: { id: "session-1", cwd: "C:\\Users\\person\\private-repo" } }),
      JSON.stringify({ timestamp: "2026-07-11T00:00:00Z", payload: { session_id: "session-1", info: { total_token_usage: { input_tokens: 12, output_tokens: 3 } } } }),
    ].join("\n");
    const events = collectUsageDocuments(
      [{ provider: "codex", path: "C:\\logs\\session.jsonl", content }],
      "device-1",
      createCollectorState(),
    );

    expect(events).toHaveLength(1);
    expect(events[0].sessionId).toBe("session-1");
    expect(events[0].projectId).toMatch(/^local_[a-f0-9]{64}$/);
    expect(JSON.stringify(events)).not.toContain("private-repo");
  });

  it("aggregates normalized events by provider and project", () => {
    const base = {
      source: "local-jsonl" as const,
      deviceId: "d1",
      sessionId: "s1",
      occurredAt: "2026-07-11T00:00:00.000Z",
      tokens: { input: 10, cached: 2, output: 3, reasoning: 0, tool: 0 },
    };
    const events = [
      { ...base, id: "1", provider: "codex" as const, projectId: "p1" },
      { ...base, id: "2", provider: "claude" as const, projectId: "p1", tokens: { ...base.tokens, output: 5 } },
    ];

    expect(aggregateByProvider(events)).toEqual([
      expect.objectContaining({ provider: "codex", eventCount: 1, tokens: expect.objectContaining({ output: 3 }) }),
      expect.objectContaining({ provider: "claude", eventCount: 1, tokens: expect.objectContaining({ output: 5 }) }),
    ]);
    expect(aggregateByProject(events)[0]).toMatchObject({ projectId: "p1", eventCount: 2, tokens: { input: 20, cached: 4, output: 8 } });
  });
});
