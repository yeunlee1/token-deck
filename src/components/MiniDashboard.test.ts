// 미니 모드에 전달할 정액제 한도 계약과 표시값을 검증한다
import { describe, expect, it } from "vitest";
import { quotaStatusLabel, remainingLabel, type ProviderQuotaStatus } from "./quota-display";

describe("mini quota display", () => {
  it("5시간과 주간 토큰 합계 대신 잔여 퍼센트를 표시한다", () => {
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

    expect(remainingLabel(quota.fiveHour)).toBe("73%");
    expect(remainingLabel(quota.weekly)).toBe("39%");
    expect(quotaStatusLabel(quota)).toBe("plus");
  });
});
