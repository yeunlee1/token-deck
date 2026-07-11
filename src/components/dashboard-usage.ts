// 프로젝트와 기기 화면에서 계정 전체 API 이벤트를 제외하는 표시용 선택기
import type { Provider, UsageEvent } from "../core";

export function selectProjectDeviceEvents(events: UsageEvent[], providers: Provider[], start: Date): UsageEvent[] {
  const startTime = start.getTime();
  return events.filter((event) => (
    event.source !== "provider-api"
    && providers.includes(event.provider)
    && new Date(event.occurredAt).getTime() >= startTime
  ));
}
