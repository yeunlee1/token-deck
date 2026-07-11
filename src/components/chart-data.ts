// 실제 사용 이벤트를 조회 기간별 차트 점으로 집계하는 순수 변환기
import { tokenTotal, type UsageEvent } from "../core";

export type ChartPeriod = "오늘" | "7일" | "30일";

export interface ChartPoint {
  label: string;
  codex: number;
  claude: number;
  gemini: number;
}

interface Bucket {
  start: number;
  end: number;
  label: string;
}

const emptyPoint = (label: string): ChartPoint => ({ label, codex: 0, claude: 0, gemini: 0 });

function startOfDay(value: Date): Date {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function createBuckets(period: ChartPeriod, now: Date): Bucket[] {
  const today = startOfDay(now);
  if (period === "오늘") {
    return Array.from({ length: 8 }, (_, index) => {
      const start = new Date(today);
      start.setHours(index * 3);
      const end = new Date(start);
      end.setHours(end.getHours() + 3);
      return { start: start.getTime(), end: end.getTime(), label: `${String(index * 3).padStart(2, "0")}시` };
    });
  }

  const days = period === "7일" ? 7 : 30;
  const bucketDays = period === "7일" ? 1 : 5;
  const firstDay = new Date(today);
  firstDay.setDate(today.getDate() - days + 1);
  return Array.from({ length: days / bucketDays }, (_, index) => {
    const start = new Date(firstDay);
    start.setDate(firstDay.getDate() + index * bucketDays);
    const end = new Date(start);
    end.setDate(start.getDate() + bucketDays);
    const last = new Date(end);
    last.setDate(end.getDate() - 1);
    const label = period === "7일"
      ? start.toLocaleDateString("ko-KR", { weekday: "short" })
      : `${start.getMonth() + 1}/${start.getDate()}–${last.getMonth() + 1}/${last.getDate()}`;
    return { start: start.getTime(), end: end.getTime(), label };
  });
}

export function buildUsageChart(events: UsageEvent[], period: ChartPeriod, now = new Date()): ChartPoint[] {
  const buckets = createBuckets(period, now);
  const points = buckets.map(({ label }) => emptyPoint(label));

  for (const event of events) {
    const timestamp = new Date(event.occurredAt).getTime();
    if (!Number.isFinite(timestamp)) continue;
    const index = buckets.findIndex(({ start, end }) => timestamp >= start && timestamp < end);
    if (index < 0) continue;
    points[index][event.provider] += tokenTotal(event.tokens);
  }

  return points;
}
