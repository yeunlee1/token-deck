// 공급사별 차트 선이 색상 외의 패턴으로도 구분되는지 검증한다.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UsageChart } from "./UsageChart";

describe("UsageChart 접근성", () => {
  it("Claude와 Gemini 계열에 서로 다른 선 패턴을 제공한다", () => {
    const markup = renderToStaticMarkup(<UsageChart data={[
      { label: "월", codex: 100, claude: 80, gemini: 60 },
      { label: "화", codex: 120, claude: 90, gemini: 70 },
    ]} />);

    expect(markup).toContain('stroke-dasharray="9 5"');
    expect(markup).toContain('stroke-dasharray="2 5"');
    expect(markup).toContain('stroke-linecap="round"');
  });
});
