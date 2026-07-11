// Codex 세션 JSONL의 누적 토큰을 중복 없이 사용 이벤트로 변환하는 수집기
import { EMPTY_TOKENS, finiteNumber, firstString, isoTimestamp, objectAt, parseJsonLines, stableId, valueAt } from "./parse-utils";
import type { CollectorContext, CollectorState, TokenBreakdown, UsageEvent } from "./types";
import { tokenTotal } from "./types";

function codexTotals(record: Record<string, unknown>): TokenBreakdown | undefined {
  const usage =
    objectAt(record, "payload", "info", "total_token_usage") ??
    objectAt(record, "payload", "total_token_usage") ??
    objectAt(record, "info", "total_token_usage") ??
    objectAt(record, "total_token_usage") ??
    objectAt(record, "usage");
  if (!usage) return undefined;

  const input = finiteNumber(usage.input_tokens, usage.input);
  const cached = finiteNumber(usage.cached_input_tokens, usage.cache_read_input_tokens, usage.cached);
  const output = finiteNumber(usage.output_tokens, usage.output);
  const reasoning = finiteNumber(usage.reasoning_output_tokens, usage.reasoning_tokens, usage.reasoning);
  return {
    input: Math.max(0, input - cached),
    cached,
    output: Math.max(0, output - reasoning),
    reasoning,
    tool: finiteNumber(usage.tool_tokens, usage.tool),
  };
}

function deltaFromCumulative(current: TokenBreakdown, previous: TokenBreakdown): TokenBreakdown {
  const delta = (now: number, before: number) => Math.max(0, now - before);
  return {
    input: delta(current.input, previous.input),
    cached: delta(current.cached, previous.cached),
    output: delta(current.output, previous.output),
    reasoning: delta(current.reasoning, previous.reasoning),
    tool: delta(current.tool, previous.tool),
  };
}

export function parseCodexJsonl(
  input: string,
  context: CollectorContext,
  state: CollectorState,
): UsageEvent[] {
  const events: UsageEvent[] = [];
  const fallbackNow = context.now?.() ?? new Date();

  for (const record of parseJsonLines(input)) {
    const cumulative = codexTotals(record);
    if (!cumulative) continue;

    const sessionId = firstString(
      valueAt(record, "payload", "session_id"),
      record.session_id,
      record.sessionId,
      context.sessionId,
    ) ?? "unknown";
    const checkpointKey = `${context.deviceId}:${sessionId}`;
    const previous = state.codexCumulative[checkpointKey] ?? EMPTY_TOKENS;
    if (tokenTotal(cumulative) <= tokenTotal(previous)) continue;
    const tokens = deltaFromCumulative(cumulative, previous);
    state.codexCumulative[checkpointKey] = cumulative;
    if (tokenTotal(tokens) === 0) continue;

    const occurredAt = isoTimestamp(record.timestamp ?? record.created_at, fallbackNow);
    const model = firstString(valueAt(record, "payload", "model"), record.model);
    const identityTotals = [
      cumulative.input + cumulative.cached,
      cumulative.cached,
      cumulative.output + cumulative.reasoning,
      cumulative.reasoning,
      cumulative.tool,
    ];
    events.push({
      id: stableId("codex", context.deviceId, sessionId, occurredAt, ...identityTotals),
      provider: "codex",
      source: "local-jsonl",
      deviceId: context.deviceId,
      sessionId,
      projectId: context.projectId,
      model,
      occurredAt,
      tokens,
    });
  }

  return events;
}
