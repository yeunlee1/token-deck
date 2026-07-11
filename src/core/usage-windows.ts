// 공급사별 최근 5시간과 최근 7일의 롤링 토큰 사용량을 계산한다
import { tokenTotal, type Provider, type UsageEvent } from "./types";

export interface ProviderWindowUsage {
  provider: Provider;
  fiveHours: number;
  week: number;
  fiveHourEvents: number;
  weekEvents: number;
}

export function buildProviderWindowUsage(events: UsageEvent[], providers: Provider[], now = new Date()): ProviderWindowUsage[] {
  const end = now.getTime();
  const fiveHourStart = end - 5 * 60 * 60 * 1_000;
  const weekStart = end - 7 * 24 * 60 * 60 * 1_000;

  return providers.map((provider) => {
    const providerEvents = events.filter((event) => event.provider === provider);
    const fiveHourEvents = providerEvents.filter((event) => inWindow(event, fiveHourStart, end));
    const weekEvents = providerEvents.filter((event) => inWindow(event, weekStart, end));
    return {
      provider,
      fiveHours: sumTokens(fiveHourEvents),
      week: sumTokens(weekEvents),
      fiveHourEvents: fiveHourEvents.length,
      weekEvents: weekEvents.length,
    };
  });
}

function inWindow(event: UsageEvent, start: number, end: number): boolean {
  const occurredAt = new Date(event.occurredAt).getTime();
  return occurredAt >= start && occurredAt <= end;
}

function sumTokens(events: UsageEvent[]): number {
  return events.reduce((sum, event) => sum + tokenTotal(event.tokens), 0);
}
