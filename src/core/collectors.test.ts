// 공급사별 토큰 파서의 정규화와 중복 방지를 검증하는 테스트
import { describe, expect, it } from "vitest";

import { parseClaudeJsonl } from "./claude";
import { parseCodexJsonl } from "./codex";
import { parseGeminiOtel } from "./gemini";
import { stableId } from "./parse-utils";
import { createCollectorState } from "./types";

const context = {
  deviceId: "device-a",
  projectId: "project-a",
  sessionId: "fallback-session",
  now: () => new Date("2026-07-11T00:00:00.000Z"),
};

describe("Codex JSONL collector", () => {
  it("emits only increases from cumulative token counters", () => {
    const state = createCollectorState();
    const lines = [
      { timestamp: "2026-07-11T00:00:01Z", payload: { session_id: "s1", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 } } } },
      { timestamp: "2026-07-11T00:00:02Z", payload: { session_id: "s1", info: { total_token_usage: { input_tokens: 140, cached_input_tokens: 25, output_tokens: 18 } } } },
      { timestamp: "2026-07-11T00:00:03Z", payload: { session_id: "s1", info: { total_token_usage: { input_tokens: 140, cached_input_tokens: 25, output_tokens: 18 } } } },
    ].map((record) => JSON.stringify(record)).join("\n");

    const events = parseCodexJsonl(lines, context, state);
    expect(events.map((event) => event.tokens)).toEqual([
      { input: 80, cached: 20, output: 10, reasoning: 0, tool: 0 },
      { input: 35, cached: 5, output: 8, reasoning: 0, tool: 0 },
    ]);
    expect(parseCodexJsonl(lines, context, state)).toEqual([]);
  });

  it("does not count cached input or reasoning output twice", () => {
    const record = JSON.stringify({
      timestamp: "2026-07-11T00:00:01Z",
      payload: { session_id: "s1", info: { total_token_usage: {
        input_tokens: 23_692,
        cached_input_tokens: 9_984,
        output_tokens: 733,
        reasoning_output_tokens: 255,
        total_tokens: 24_425,
      } } },
    });

    const [event] = parseCodexJsonl(record, context, createCollectorState());
    expect(Object.values(event.tokens).reduce((sum, value) => sum + value, 0)).toBe(24_425);
    expect(event.id).toBe(stableId("codex", "device-a", "s1", "2026-07-11T00:00:01.000Z", 23_692, 9_984, 733, 255, 0));
  });

  it("ignores malformed and content-only lines", () => {
    const input = '{"type":"message","content":"secret prompt"}\n{"partial":';
    expect(parseCodexJsonl(input, context, createCollectorState())).toEqual([]);
  });
});

describe("Claude JSONL collector", () => {
  it("deduplicates a request id while retaining token metadata only", () => {
    const state = createCollectorState();
    const record = JSON.stringify({
      sessionId: "claude-s1",
      requestId: "req-1",
      timestamp: "2026-07-11T00:01:00Z",
      message: {
        model: "claude-sonnet",
        content: [{ type: "text", text: "private response" }],
        usage: { input_tokens: 20, cache_creation_input_tokens: 6, cache_read_input_tokens: 4, output_tokens: 7, thinking_tokens: 3 },
      },
    });

    const events = parseClaudeJsonl(`${record}\n${record}`, context, state);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ requestId: "req-1", tokens: { input: 20, cached: 10, output: 4, reasoning: 3 } });
    expect(JSON.stringify(events)).not.toContain("private response");
  });
});

describe("Gemini OTel collector", () => {
  it("reads OTLP attribute arrays and nanosecond timestamps", () => {
    const payload = JSON.stringify({
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [{
            timeUnixNano: "1783728123000000000",
            body: { stringValue: "private prompt must not escape" },
            attributes: [
              { key: "session.id", value: { stringValue: "gemini-s1" } },
              { key: "gen_ai.request.id", value: { stringValue: "gemini-r1" } },
              { key: "gen_ai.request.model", value: { stringValue: "gemini-2.5-pro" } },
              { key: "gen_ai.usage.input_tokens", value: { intValue: "11" } },
              { key: "cached_content_token_count", value: { intValue: "4" } },
              { key: "gen_ai.usage.output_tokens", value: { intValue: "9" } },
              { key: "thoughts_token_count", value: { intValue: 3 } },
            ],
          }],
        }],
      }],
    });
    const state = createCollectorState();

    const events = parseGeminiOtel(payload, context, state);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sessionId: "gemini-s1",
      requestId: "gemini-r1",
      model: "gemini-2.5-pro",
      tokens: { input: 7, cached: 4, output: 9, reasoning: 3 },
    });
    expect(parseGeminiOtel(payload, context, state)).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("private prompt");
  });

  it("reads the classic FileLogExporter record as the complete token authority", () => {
    const classic = {
      hrTime: [1_783_771_323, 456_000_000],
      body: "private response body",
      attributes: {
        "event.name": "gemini_cli.api_response",
        "event.timestamp": "2026-07-11T12:02:03.456Z",
        "session.id": "gemini-file-session",
        prompt_id: "prompt-1",
        model: "gemini-2.5-pro",
        input_token_count: 20,
        cached_content_token_count: 5,
        output_token_count: 7,
        thoughts_token_count: 3,
        tool_token_count: 2,
        "user.email": "private@example.com",
        response_text: "private response",
      },
    };

    const [event] = parseGeminiOtel(JSON.stringify(classic), context, createCollectorState());
    expect(event).toMatchObject({
      requestId: "prompt-1",
      occurredAt: "2026-07-11T12:02:03.456Z",
      tokens: { input: 15, cached: 5, output: 7, reasoning: 3, tool: 2 },
    });
    expect(JSON.stringify(event)).not.toContain("private@example.com");
    expect(JSON.stringify(event)).not.toContain("private response");
  });

  it("uses hrTime when an event timestamp is absent and keeps the id stable across restarts", () => {
    const record = JSON.stringify({
      hrTime: [1_783_771_323, 456_000_000],
      attributes: {
        "event.name": "gemini_cli.api_response",
        "session.id": "gemini-file-session",
        prompt_id: "stable-prompt",
        model: "gemini-2.5-pro",
        input_token_count: 9,
        output_token_count: 4,
      },
    });

    const first = parseGeminiOtel(record, { ...context, now: () => new Date("2030-01-01T00:00:00Z") }, createCollectorState())[0];
    const restarted = parseGeminiOtel(record, { ...context, now: () => new Date("2040-01-01T00:00:00Z") }, createCollectorState())[0];
    expect(first.occurredAt).toBe("2026-07-11T12:02:03.456Z");
    expect(restarted.id).toBe(first.id);
  });

  it("prefers the classic record over its semantic duplicate", () => {
    const common = {
      "event.timestamp": "2026-07-11T12:02:03.456Z",
      "session.id": "gemini-file-session",
    };
    const classic = {
      attributes: {
        ...common,
        "event.name": "gemini_cli.api_response",
        prompt_id: "prompt-authority",
        model: "gemini-2.5-pro",
        input_token_count: 20,
        cached_content_token_count: 5,
        output_token_count: 7,
        thoughts_token_count: 3,
        tool_token_count: 2,
      },
    };
    const semantic = {
      attributes: {
        ...common,
        "event.name": "gen_ai.client.inference.operation.details",
        "gen_ai.response.id": "response-duplicate",
        "gen_ai.request.model": "gemini-2.5-pro",
        "gen_ai.usage.input_tokens": 20,
        "gen_ai.usage.output_tokens": 7,
      },
    };

    for (const records of [[classic, semantic], [semantic, classic]]) {
      const events = parseGeminiOtel(JSON.stringify(records), context, createCollectorState());
      expect(events).toHaveLength(1);
      expect(events[0].requestId).toBe("prompt-authority");
      expect(events[0].tokens).toEqual({ input: 15, cached: 5, output: 7, reasoning: 3, tool: 2 });
    }

    const splitState = createCollectorState();
    const [semanticFirst] = parseGeminiOtel(JSON.stringify(semantic), context, splitState);
    const [classicLater] = parseGeminiOtel(JSON.stringify(classic), context, splitState);
    expect(classicLater.id).toBe(semanticFirst.id);
    expect(classicLater.tokens).toEqual({ input: 15, cached: 5, output: 7, reasoning: 3, tool: 2 });
  });

  it("does not collapse distinct responses with identical timestamps and token counts", () => {
    const attributes = {
      "event.name": "gemini_cli.api_response",
      "event.timestamp": "2026-07-11T12:02:03.456Z",
      "session.id": "gemini-file-session",
      model: "gemini-2.5-pro",
      input_token_count: 9,
      output_token_count: 4,
    };
    const payload = JSON.stringify([
      { attributes: { ...attributes, prompt_id: "prompt-a" } },
      { attributes: { ...attributes, prompt_id: "prompt-b" } },
    ]);

    const events = parseGeminiOtel(payload, context, createCollectorState());
    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.id)).size).toBe(2);
  });

  it("keeps multiple API calls that share one prompt id", () => {
    const attributes = {
      "event.name": "gemini_cli.api_response",
      "event.timestamp": "2026-07-11T12:02:03.456Z",
      "session.id": "gemini-file-session",
      prompt_id: "shared-prompt",
      model: "gemini-2.5-pro",
      input_token_count: 9,
      output_token_count: 4,
    };
    const payload = JSON.stringify([
      { hrTime: [1_783_771_323, 456_000_001], attributes },
      { hrTime: [1_783_771_323, 456_000_002], attributes },
    ]);

    const events = parseGeminiOtel(payload, context, createCollectorState());
    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.id)).size).toBe(2);
  });
});
