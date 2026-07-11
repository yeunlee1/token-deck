// Claude Code JSONL의 요청별 토큰을 중복 없이 사용 이벤트로 변환하는 수집기
import { finiteNumber, firstString, isoTimestamp, objectAt, parseJsonLines, stableId, valueAt } from "./parse-utils";
import type { CollectorContext, CollectorState, UsageEvent } from "./types";
import { tokenTotal } from "./types";

export function parseClaudeJsonl(
  input: string,
  context: CollectorContext,
  state: CollectorState,
): UsageEvent[] {
  const events: UsageEvent[] = [];
  const fallbackNow = context.now?.() ?? new Date();

  for (const record of parseJsonLines(input)) {
    const message = objectAt(record, "message") ?? record;
    const usage = objectAt(message, "usage") ?? objectAt(record, "usage");
    if (!usage) continue;

    const sessionId = firstString(record.sessionId, record.session_id, context.sessionId) ?? "unknown";
    const occurredAt = isoTimestamp(record.timestamp ?? record.created_at, fallbackNow);
    const requestId = firstString(
      record.requestId,
      record.request_id,
      message.id,
      valueAt(record, "response", "id"),
    ) ?? stableId("claude-request", context.deviceId, sessionId, occurredAt, message.model as string | undefined);
    const requestKey = `${context.deviceId}:${requestId}`;
    if (state.claudeRequestIds.has(requestKey)) continue;

    const output = finiteNumber(usage.output_tokens, usage.output);
    const reasoning = finiteNumber(usage.thinking_tokens, usage.reasoning_tokens, usage.reasoning);
    const tokens = {
      input: finiteNumber(usage.input_tokens, usage.input),
      cached: finiteNumber(usage.cache_read_input_tokens) + finiteNumber(usage.cache_creation_input_tokens, usage.cached_input_tokens, usage.cached),
      output: Math.max(0, output - reasoning),
      reasoning,
      tool: finiteNumber(usage.tool_tokens, usage.tool),
    };
    if (tokenTotal(tokens) === 0) continue;

    state.claudeRequestIds.add(requestKey);
    events.push({
      id: stableId("claude", context.deviceId, requestId),
      provider: "claude",
      source: "local-jsonl",
      deviceId: context.deviceId,
      sessionId,
      projectId: context.projectId,
      model: firstString(message.model, record.model),
      occurredAt,
      tokens,
      requestId,
    });
  }

  return events;
}
