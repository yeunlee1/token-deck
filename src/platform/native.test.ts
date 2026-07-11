// 웹 브라우저에서 네이티브 한도 기능이 안전하게 비활성화되는지 검증하는 테스트
import { describe, expect, it } from "vitest";
import { configureClaudeQuotaCapture, getClaudeQuotaCaptureStatus, getQuotaStatuses } from "./native";

describe("native quota bridge browser fallback", () => {
  it("공급사 세 곳의 미지원 상태를 반환한다", async () => {
    const statuses = await getQuotaStatuses();
    expect(statuses.map((status) => status.provider)).toEqual(["codex", "claude", "gemini"]);
    expect(statuses.every((status) => !status.supported && status.fiveHour === null)).toBe(true);
  });

  it("Claude 수집 상태는 비활성이고 설정 변경은 거부한다", async () => {
    await expect(getClaudeQuotaCaptureStatus()).resolves.toEqual({ configured: false, settingsPath: "", dataPath: "", hasData: false, existingStatusLine: false });
    await expect(configureClaudeQuotaCapture()).rejects.toThrow("데스크톱 앱");
  });
});
