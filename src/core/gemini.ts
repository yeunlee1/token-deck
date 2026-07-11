// Gemini CLI OpenTelemetry JSON과 JSONL을 사용 이벤트로 변환하는 수집기
import { attributesToObject, finiteNumber, firstString, isObject, isoTimestamp, parseJsonLines, stableId } from "./parse-utils";
import type { CollectorContext, CollectorState, UsageEvent } from "./types";
import { tokenTotal } from "./types";

function collectOtelRecords(root: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(root.resourceLogs)) {
    return root.resourceLogs.flatMap((resourceLog) => {
      if (!isObject(resourceLog) || !Array.isArray(resourceLog.scopeLogs)) return [];
      return resourceLog.scopeLogs.flatMap((scopeLog) => {
        if (!isObject(scopeLog) || !Array.isArray(scopeLog.logRecords)) return [];
        return scopeLog.logRecords.filter(isObject);
      });
    });
  }
  return [root];
}

function attr(attrs: Record<string, unknown>, ...keys: string[]): unknown[] {
  return keys.map((key) => attrs[key]);
}

export function parseGeminiOtel(
  input: string,
  context: CollectorContext,
  state: CollectorState,
): UsageEvent[] {
  const trimmed = input.trim();
  if (!trimmed) return [];
  let roots: Record<string, unknown>[];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    roots = Array.isArray(parsed) ? parsed.filter(isObject) : isObject(parsed) ? [parsed] : [];
  } catch {
    roots = parseJsonLines(input);
  }

  const fallbackNow = context.now?.() ?? new Date();
  const events: UsageEvent[] = [];
  for (const root of roots) {
    for (const record of collectOtelRecords(root)) {
      const attrs = attributesToObject(record.attributes ?? record.attribute);
      const input = finiteNumber(...attr(attrs, "gen_ai.usage.input_tokens", "input_token_count", "input_tokens"));
      const cached = finiteNumber(...attr(attrs, "gen_ai.usage.cached_tokens", "cached_content_token_count", "cached_token_count", "cached_tokens"));
      const tokens = {
        input: Math.max(0, input - cached),
        cached,
        output: finiteNumber(...attr(attrs, "gen_ai.usage.output_tokens", "output_token_count", "output_tokens")),
        reasoning: finiteNumber(...attr(attrs, "gen_ai.usage.reasoning_tokens", "thoughts_token_count", "reasoning_tokens")),
        tool: finiteNumber(...attr(attrs, "gen_ai.usage.tool_tokens", "tool_token_count", "tool_tokens")),
      };
      if (tokenTotal(tokens) === 0) continue;

      const sessionId = firstString(
        ...attr(attrs, "session.id", "session_id", "gemini.session_id"),
        context.sessionId,
      ) ?? "unknown";
      const timestampRaw = record.timeUnixNano ?? record.observedTimeUnixNano ?? record.timestamp;
      const occurredAt = typeof timestampRaw === "string" && /^\d{16,}$/.test(timestampRaw)
        ? new Date(Number(BigInt(timestampRaw) / 1_000_000n)).toISOString()
        : isoTimestamp(timestampRaw, fallbackNow);
      const requestId = firstString(...attr(attrs, "gen_ai.request.id", "request_id", "event.id"));
      const eventId = requestId ?? stableId("gemini-event", context.deviceId, sessionId, occurredAt, ...Object.values(tokens));
      const eventKey = `${context.deviceId}:${eventId}`;
      if (state.geminiEventIds.has(eventKey)) continue;
      state.geminiEventIds.add(eventKey);

      events.push({
        id: stableId("gemini", context.deviceId, eventId),
        provider: "gemini",
        source: "otel",
        deviceId: context.deviceId,
        sessionId,
        projectId: context.projectId,
        model: firstString(...attr(attrs, "gen_ai.request.model", "model", "model_name")),
        occurredAt,
        tokens,
        requestId,
      });
    }
  }
  return events;
}
