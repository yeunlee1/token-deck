// 한도 상태 배열을 공급사별 안정적인 레코드로 변환하는지 검증하는 테스트
import { describe, expect, it } from "vitest";
import { pendingQuotaRecord, quotaRecord } from "./useProviderQuotas";

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

  it("미선택 공급사는 수집 꺼짐 상태로 구분한다", () => {
    const result = quotaRecord([{
      provider: "codex", supported: true, planType: "pro",
      fiveHour: null, weekly: { usedPercent: 20, remainingPercent: 80, windowMinutes: 10_080, resetsAt: null },
      daily: null, message: null, updatedAt: 100,
    }], ["codex"]);

    expect(result.codex.weekly?.remainingPercent).toBe(80);
    expect(result.claude.message).toBe("설정에서 수집이 꺼져 있습니다.");
    expect(result.gemini.message).toBe("설정에서 수집이 꺼져 있습니다.");
  });

  it("다시 활성화한 공급사는 네이티브 응답 전까지 확인 중으로 표시한다", () => {
    const result = pendingQuotaRecord(["claude"]);

    expect(result.claude.message).toBe("잔여 한도를 확인 중입니다.");
    expect(result.codex.message).toBe("설정에서 수집이 꺼져 있습니다.");
  });
});
