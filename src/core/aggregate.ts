// 정규화한 사용 이벤트를 공급사와 프로젝트 기준으로 합산하는 집계기
import type { Provider, TokenBreakdown, UsageEvent } from "./types";

export interface UsageAggregate {
  key: string;
  provider?: Provider;
  projectId?: string;
  eventCount: number;
  tokens: TokenBreakdown;
}

function sum(events: UsageEvent[], key: string): UsageAggregate {
  return events.reduce<UsageAggregate>((aggregate, event) => {
    aggregate.eventCount += 1;
    aggregate.tokens.input += event.tokens.input;
    aggregate.tokens.cached += event.tokens.cached;
    aggregate.tokens.output += event.tokens.output;
    aggregate.tokens.reasoning += event.tokens.reasoning;
    aggregate.tokens.tool += event.tokens.tool;
    return aggregate;
  }, {
    key,
    eventCount: 0,
    tokens: { input: 0, cached: 0, output: 0, reasoning: 0, tool: 0 },
  });
}

export function aggregateByProvider(events: UsageEvent[]): UsageAggregate[] {
  return (["codex", "claude", "gemini"] as const).flatMap((provider) => {
    const matching = events.filter((event) => event.provider === provider);
    if (matching.length === 0) return [];
    return [{ ...sum(matching, provider), provider }];
  });
}

export function aggregateByProject(events: UsageEvent[]): UsageAggregate[] {
  const projectIds = [...new Set(events.map((event) => event.projectId))];
  return projectIds.map((projectId) => ({
    ...sum(events.filter((event) => event.projectId === projectId), projectId),
    projectId,
  }));
}
