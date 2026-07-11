// 한도 상태 배열을 공급사별 안정적인 레코드로 변환하는지 검증하는 테스트
import { describe, expect, it } from "vitest";
import { quotaRecord } from "./useProviderQuotas";

describe("quotaRecord", () => {
  it("누락 공급사는 미지원 기본값으로 채운다", () => {
    const result = quotaRecord([{
      provider: "codex", supported: true, planType: "plus",
      fiveHour: { usedPercent: 25, remainingPercent: 75, windowMinutes: 300, resetsAt: 123 },
      weekly: null, daily: null, message: null, updatedAt: 100,
    }]);
    expect(result.codex.fiveHour?.remainingPercent).toBe(75);
    expect(result.claude.supported).toBe(false);
    expect(result.gemini.supported).toBe(false);
  });
});
