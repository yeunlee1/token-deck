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

const CLASSIC_API_RESPONSE = "gemini_cli.api_response";
const SEMANTIC_API_RESPONSE = "gen_ai.client.inference.operation.details";

function hasAny(attrs: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => attrs[key] !== undefined);
}

function hrTimeTimestamp(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  try {
    const seconds = BigInt(String(value[0]));
    const nanoseconds = BigInt(String(value[1]));
    const milliseconds = seconds * 1_000n + nanoseconds / 1_000_000n;
    const date = new Date(Number(milliseconds));
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  } catch {
    return undefined;
  }
}

function recordTimestamp(
  record: Record<string, unknown>,
  attrs: Record<string, unknown>,
  fallback: Date,
): string {
  const timestamp = firstString(record.timestamp, attrs["event.timestamp"]);
  if (timestamp) return isoTimestamp(timestamp, fallback);

  const unixNano = record.timeUnixNano ?? record.observedTimeUnixNano;
  if (typeof unixNano === "string" && /^\d{16,}$/.test(unixNano)) {
    return new Date(Number(BigInt(unixNano) / 1_000_000n)).toISOString();
  }
  return hrTimeTimestamp(record.hrTime)
    ?? hrTimeTimestamp(record.hrTimeObserved)
    ?? isoTimestamp(unixNano, fallback);
}

function recordClockIdentity(record: Record<string, unknown>, occurredAt: string): string {
  const unixNano = record.timeUnixNano ?? record.observedTimeUnixNano;
  if (typeof unixNano === "string" || typeof unixNano === "number") return String(unixNano);
  const hrTime = Array.isArray(record.hrTime) ? record.hrTime : record.hrTimeObserved;
  return Array.isArray(hrTime) && hrTime.length === 2 ? `${hrTime[0]}:${hrTime[1]}` : occurredAt;
}

function usageKinds(attrs: Record<string, unknown>): { classic: boolean; semantic: boolean } {
  const eventName = firstString(attrs["event.name"]);
  return {
    classic: eventName === CLASSIC_API_RESPONSE || hasAny(attrs, [
      "input_token_count",
      "output_token_count",
      "cached_content_token_count",
      "thoughts_token_count",
      "tool_token_count",
    ]),
    semantic: eventName === SEMANTIC_API_RESPONSE || hasAny(attrs, [
      "gen_ai.usage.input_tokens",
      "gen_ai.usage.output_tokens",
    ]),
  };
}

function reserveOccurrence(
  state: CollectorState,
  deviceId: string,
  kind: "classic" | "semantic",
  operationId: string,
): number {
  let index = 0;
  while (state.geminiEventIds.has(`${deviceId}:${kind}-occurrence:${operationId}:${index}`)) index += 1;
  state.geminiEventIds.add(`${deviceId}:${kind}-occurrence:${operationId}:${index}`);
  return index;
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
  const records = roots
    .flatMap(collectOtelRecords)
    .map((record) => {
      const attrs = attributesToObject(record.attributes ?? record.attribute);
      return { record, attrs, ...usageKinds(attrs) };
    })
    .sort((left, right) => Number(!left.classic) - Number(!right.classic));
  for (const { record, attrs, classic, semantic } of records) {
    if (!classic && !semantic) continue;

    const input = finiteNumber(...attr(attrs, "input_token_count", "gen_ai.usage.input_tokens", "input_tokens"));
    const cached = finiteNumber(...attr(attrs, "gen_ai.usage.cached_tokens", "cached_content_token_count", "cached_token_count", "cached_tokens"));
    const tokens = {
      input: Math.max(0, input - cached),
      cached,
      output: finiteNumber(...attr(attrs, "output_token_count", "gen_ai.usage.output_tokens", "output_tokens")),
      reasoning: finiteNumber(...attr(attrs, "thoughts_token_count", "gen_ai.usage.reasoning_tokens", "reasoning_tokens")),
      tool: finiteNumber(...attr(attrs, "tool_token_count", "gen_ai.usage.tool_tokens", "tool_tokens")),
    };
    if (tokenTotal(tokens) === 0) continue;

    const sessionId = firstString(
      ...attr(attrs, "session.id", "session_id", "gemini.session_id"),
      context.sessionId,
    ) ?? "unknown";
    const occurredAt = recordTimestamp(record, attrs, fallbackNow);
    const model = firstString(...attr(attrs, "gen_ai.request.model", "model", "model_name"));
    const responseId = firstString(...attr(
      attrs,
      "gen_ai.response.id",
      "gen_ai.request.id",
      "request_id",
      "event.id",
    ));
    const promptId = firstString(attrs.prompt_id);
    const requestId = responseId ?? promptId;
    const operationId = stableId("gemini-operation", context.deviceId, sessionId, occurredAt, model, input, tokens.output);
    const sourceIdentity = responseId ?? (promptId
      ? stableId("gemini-prompt-event", promptId, recordClockIdentity(record, occurredAt), model, input, ...Object.values(tokens))
      : operationId);
    const sourceKey = `${context.deviceId}:gemini-source:${sourceIdentity}`;
    if (state.geminiEventIds.has(sourceKey)) continue;
    state.geminiEventIds.add(sourceKey);

    const kind = classic ? "classic" : "semantic";
    const occurrence = reserveOccurrence(state, context.deviceId, kind, operationId);
    const classicOccurrenceKey = `${context.deviceId}:classic-occurrence:${operationId}:${occurrence}`;
    if (!classic && state.geminiEventIds.has(classicOccurrenceKey)) continue;
    const eventId = stableId("gemini-operation-event", operationId, occurrence);

    events.push({
      id: stableId("gemini", context.deviceId, eventId),
      provider: "gemini",
      source: "otel",
      deviceId: context.deviceId,
      sessionId,
      projectId: context.projectId,
      model,
      occurredAt,
      tokens,
      requestId,
    });
  }
  return events;
}
