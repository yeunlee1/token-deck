// 기간별 토큰 사용량 추이를 SVG로 시각화하는 차트
import type { ChartPoint } from "./chart-data";

interface UsageChartProps {
  data: ChartPoint[];
}

const series = [
  { key: "codex", color: "#171b24" },
  { key: "claude", color: "#b5da32" },
  { key: "gemini", color: "#6b7af7" },
] as const;

export function UsageChart({ data }: UsageChartProps) {
  const width = 760;
  const height = 250;
  const pad = { top: 18, right: 14, bottom: 35, left: 14 };
  const max = Math.max(1, ...data.flatMap((item) => series.map(({ key }) => item[key]))) * 1.12;

  const pointsFor = (key: (typeof series)[number]["key"]) =>
    data
      .map((item, index) => {
        const x = pad.left + (index / (data.length - 1)) * (width - pad.left - pad.right);
        const y = pad.top + (1 - item[key] / max) * (height - pad.top - pad.bottom);
        return `${x},${y}`;
      })
      .join(" ");

  return (
    <div className="chart-wrap" role="img" aria-label="Codex, Claude, Gemini의 기간별 토큰 사용량 선 그래프">
      <svg className="usage-chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        {[0, 1, 2, 3].map((line) => {
          const y = pad.top + (line / 3) * (height - pad.top - pad.bottom);
          return <line key={line} x1={pad.left} x2={width - pad.right} y1={y} y2={y} className="chart-gridline" />;
        })}
        {series.map(({ key, color }) => (
          <g key={key}>
            <polyline points={pointsFor(key)} fill="none" stroke={color} strokeWidth="3" vectorEffect="non-scaling-stroke" />
            {data.map((item, index) => {
              const [x, y] = pointsFor(key).split(" ")[index].split(",");
              return <circle key={`${key}-${item.label}`} cx={x} cy={y} r="3.5" fill="#fff" stroke={color} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />;
            })}
          </g>
        ))}
        {data.map((item, index) => {
          const x = pad.left + (index / (data.length - 1)) * (width - pad.left - pad.right);
          return <text key={item.label} x={x} y={height - 8} textAnchor="middle" className="chart-label">{item.label}</text>;
        })}
      </svg>
    </div>
  );
}
