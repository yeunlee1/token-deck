// 정액제 잔여 퍼센트의 반올림과 경고 단계 표시를 검증한다
import { describe, expect, it } from "vitest";
import { quotaStatusLabel, quotaWindowLabel, remainingLabel, remainingTone, type ProviderQuotaStatus, type QuotaWindowStatus } from "./quota-display";

function quota(remainingPercent: number): QuotaWindowStatus {
  return { usedPercent: 100 - remainingPercent, remainingPercent, windowMinutes: 300, resetsAt: null };
}

describe("quota display", () => {
  it("잔여 퍼센트를 반올림하고 안전 범위로 제한한다", () => {
    expect(remainingLabel(quota(62.6))).toBe("63%");
    expect(remainingLabel(quota(-4))).toBe("0%");
    expect(remainingLabel(quota(104))).toBe("100%");
    expect(remainingLabel(null)).toBe("—");
  });

  it("잔여량에 따라 경고 단계를 구분한다", () => {
    expect(remainingTone(quota(70))).toBe("safe");
    expect(remainingTone(quota(30))).toBe("watch");
    expect(remainingTone(quota(10))).toBe("low");
    expect(remainingTone(null)).toBe("unknown");
  });

  it("지원되지 않는 공급사의 안내 메시지를 그대로 표시한다", () => {
    const status: ProviderQuotaStatus = { provider: "gemini", supported: false, planType: null, fiveHour: null, weekly: null, daily: null, message: "정액제 한도 미제공", updatedAt: null };
    expect(quotaStatusLabel(status)).toBe("정액제 한도 미제공");
  });

  it("지원 공급사가 일부 한도 창만 제공하면 누락 상태를 구분한다", () => {
    const status: ProviderQuotaStatus = { provider: "codex", supported: true, planType: "pro", fiveHour: null, weekly: quota(81), daily: null, message: null, updatedAt: null };
    expect(quotaWindowLabel(status, "fiveHour")).toBe("현재 미제공");
    expect(quotaWindowLabel(status, "weekly")).toBe("81%");
  });
});
