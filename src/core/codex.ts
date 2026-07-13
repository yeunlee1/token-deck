// Codex 세션 JSONL의 누적 토큰을 중복 없이 사용 이벤트로 변환하는 수집기
import { EMPTY_TOKENS, finiteNumber, firstString, isoTimestamp, objectAt, parseJsonLines, stableId, valueAt } from "./parse-utils";
import type { CollectorContext, CollectorState, TokenBreakdown, UsageEvent } from "./types";
import { tokenTotal } from "./types";

export const MAX_CODEX_CUMULATIVE_CHECKPOINTS = 50_000;
const CODEX_RETIRED_SESSION_FILTER_BYTES = 1024 * 1024;
const CODEX_RETIRED_SESSION_FILTER_HASHES = 8;

function decodeRetiredSessionFilter(encoded = ""): Uint8Array {
  if (!encoded) return new Uint8Array(CODEX_RETIRED_SESSION_FILTER_BYTES);
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new Error("Codex 퇴역 세션 필터가 손상되었습니다.");
  }
  if (binary.length !== CODEX_RETIRED_SESSION_FILTER_BYTES) {
    throw new Error("Codex 퇴역 세션 필터 크기가 올바르지 않습니다.");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeRetiredSessionFilter(filter: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < filter.length; offset += 32_768) {
    chunks.push(String.fromCharCode(...filter.subarray(offset, offset + 32_768)));
  }
  return btoa(chunks.join(""));
}

function retiredSessionFilterIndexes(checkpointKey: string): number[] {
  const hash = stableId(checkpointKey);
  const bitLength = CODEX_RETIRED_SESSION_FILTER_BYTES * 8;
  return Array.from({ length: CODEX_RETIRED_SESSION_FILTER_HASHES }, (_, index) => (
    Number.parseInt(hash.slice(index * 8, index * 8 + 8), 16) % bitLength
  ));
}

function retiredSessionFilterHas(filter: Uint8Array, checkpointKey: string): boolean {
  return retiredSessionFilterIndexes(checkpointKey).every((bit) => (
    (filter[Math.floor(bit / 8)] & (1 << (bit % 8))) !== 0
  ));
}

function addRetiredSessionKeys(encoded: string, checkpointKeys: string[]): string {
  if (!checkpointKeys.length) return encoded;
  const filter = decodeRetiredSessionFilter(encoded);
  for (const checkpointKey of checkpointKeys) {
    for (const bit of retiredSessionFilterIndexes(checkpointKey)) {
      filter[Math.floor(bit / 8)] |= 1 << (bit % 8);
    }
  }
  return encodeRetiredSessionFilter(filter);
}

function touchCodexCheckpoint(
  state: CollectorState,
  checkpointKey: string,
  cumulative: TokenBreakdown,
): void {
  delete state.codexCumulative[checkpointKey];
  state.codexCumulative[checkpointKey] = cumulative;
}

export function pruneCodexCumulativeCheckpoints(
  state: CollectorState,
  limit = MAX_CODEX_CUMULATIVE_CHECKPOINTS,
): number {
  const entries = Object.entries(state.codexCumulative);
  const boundedLimit = Number.isFinite(limit)
    ? Math.max(0, Math.floor(limit))
    : MAX_CODEX_CUMULATIVE_CHECKPOINTS;
  if (entries.length <= boundedLimit) return 0;

  const retireCount = entries.length - boundedLimit;
  const retiredKeys = entries.slice(0, retireCount).map(([checkpointKey]) => checkpointKey);
  state.codexCumulative = Object.fromEntries(entries.slice(retireCount));
  state.codexRetiredSessionFilter = addRetiredSessionKeys(
    state.codexRetiredSessionFilter,
    retiredKeys,
  );
  return retiredKeys.length;
}

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

export function applyCodexCumulativeBaselines(
  input: string,
  deviceId: string,
  state: CollectorState,
): void {
  for (const record of parseJsonLines(input)) {
    const cumulative = codexTotals(record);
    if (!cumulative) continue;
    const sessionId = firstString(
      valueAt(record, "payload", "session_id"),
      record.session_id,
      record.sessionId,
    );
    if (!sessionId) continue;
    const checkpointKey = `${deviceId}:${sessionId}`;
    const previous = state.codexCumulative[checkpointKey];
    if (tokenTotal(cumulative) > tokenTotal(previous ?? EMPTY_TOKENS)) {
      touchCodexCheckpoint(state, checkpointKey, cumulative);
    } else if (previous) {
      touchCodexCheckpoint(state, checkpointKey, previous);
    }
  }
}

export function parseCodexJsonl(
  input: string,
  context: CollectorContext,
  state: CollectorState,
): UsageEvent[] {
  const events: UsageEvent[] = [];
  const fallbackNow = context.now?.() ?? new Date();
  let retiredSessionFilter: Uint8Array | undefined;

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
    if (!(checkpointKey in state.codexCumulative) && state.codexRetiredSessionFilter) {
      retiredSessionFilter ??= decodeRetiredSessionFilter(state.codexRetiredSessionFilter);
      if (retiredSessionFilterHas(retiredSessionFilter, checkpointKey)) {
        touchCodexCheckpoint(state, checkpointKey, cumulative);
        continue;
      }
    }
    const hasCheckpoint = Object.prototype.hasOwnProperty.call(state.codexCumulative, checkpointKey);
    const previous = hasCheckpoint ? state.codexCumulative[checkpointKey] : EMPTY_TOKENS;
    if (tokenTotal(cumulative) <= tokenTotal(previous)) {
      if (hasCheckpoint) touchCodexCheckpoint(state, checkpointKey, previous);
      continue;
    }
    const tokens = deltaFromCumulative(cumulative, previous);
    touchCodexCheckpoint(state, checkpointKey, cumulative);
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
