// 미니모드가 한도 정보와 핀 상태만 간결하게 표시하는지 검증한다
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MiniDashboard } from "./MiniDashboard";
import { quotaStatusLabel, quotaWindowLabel, remainingLabel, type ProviderQuotaStatus } from "./quota-display";

const quota: ProviderQuotaStatus = {
  provider: "codex",
  supported: true,
  planType: "plus",
  fiveHour: { usedPercent: 27.4, remainingPercent: 72.6, windowMinutes: 300, resetsAt: null },
  weekly: { usedPercent: 61.2, remainingPercent: 38.8, windowMinutes: 10_080, resetsAt: null },
  daily: null,
  message: null,
  updatedAt: null,
};

describe("mini quota display", () => {
  it("5시간과 주간 토큰 합계 대신 잔여 퍼센트를 표시한다", () => {
    expect(remainingLabel(quota.fiveHour)).toBe("73%");
    expect(remainingLabel(quota.weekly)).toBe("39%");
    expect(quotaStatusLabel(quota)).toBe("plus");
  });

  it("핀 상태를 노출하고 새로고침과 불투명도 조절은 렌더링하지 않는다", () => {
    const markup = renderToStaticMarkup(<MiniDashboard quotas={[quota]} providers={["codex"]} showTotal totalTokens={12_345} totalPeriod="7일" updatedAt={new Date("2026-07-12T00:00:00Z")} syncing={false} pinned onToggleProvider={vi.fn()} onTogglePinned={vi.fn()} onExit={vi.fn()} />);

    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-label="창 고정 해제"');
    expect(markup).toContain('aria-label="7일 총 토큰 12,345"');
    expect(markup).toContain("7일 TOTAL");
    expect(markup).not.toContain("한도 새로고침");
    expect(markup).not.toContain("불투명도");
    expect(markup).not.toContain('type="range"');
  });

  it("설정에서 총 토큰 표시를 끄면 합계 영역을 숨긴다", () => {
    const markup = renderToStaticMarkup(<MiniDashboard quotas={[quota]} providers={["codex"]} showTotal={false} totalTokens={12_345} totalPeriod="7일" syncing={false} pinned={false} onToggleProvider={vi.fn()} onTogglePinned={vi.fn()} onExit={vi.fn()} />);

    expect(markup).not.toContain("7일 TOTAL");
    expect(markup).not.toContain("총 토큰 12,345");
  });

  it("최신 Codex 이벤트가 주간 창만 주면 5시간 미제공과 주간 잔여량을 표시한다", () => {
    const weeklyOnly = { ...quota, fiveHour: null, weekly: { usedPercent: 19, remainingPercent: 81, windowMinutes: 10_080, resetsAt: null } };
    const markup = renderToStaticMarkup(<MiniDashboard quotas={[weeklyOnly]} providers={["codex"]} showTotal={false} totalTokens={0} totalPeriod="7일" syncing={false} pinned={false} onToggleProvider={vi.fn()} onTogglePinned={vi.fn()} onExit={vi.fn()} />);

    expect(quotaWindowLabel(weeklyOnly, "fiveHour")).toBe("현재 미제공");
    expect(markup).toContain("현재 미제공");
    expect(markup).toContain("81%");
  });
});
