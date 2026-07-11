// 미니모드가 한도 정보와 핀 상태만 간결하게 표시하는지 검증한다
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MiniDashboard } from "./MiniDashboard";
import { quotaStatusLabel, remainingLabel, type ProviderQuotaStatus } from "./quota-display";

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
    const markup = renderToStaticMarkup(<MiniDashboard quotas={[quota]} providers={["codex"]} updatedAt={new Date("2026-07-12T00:00:00Z")} syncing={false} pinned onToggleProvider={vi.fn()} onTogglePinned={vi.fn()} onExit={vi.fn()} />);

    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-label="창 고정 해제"');
    expect(markup).not.toContain("한도 새로고침");
    expect(markup).not.toContain("불투명도");
    expect(markup).not.toContain('type="range"');
  });
});
