// 웹 브라우저 대체 동작과 선택 공급사 한도 명령을 검증하는 테스트
import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureClaudeQuotaCapture, getClaudeQuotaCaptureStatus, getQuotaStatuses } from "./native";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => {
  vi.mocked(invoke).mockReset();
  vi.unstubAllGlobals();
});

describe("native quota bridge browser fallback", () => {
  it("공급사 세 곳의 미지원 상태를 반환한다", async () => {
    const statuses = await getQuotaStatuses();
    expect(statuses.map((status) => status.provider)).toEqual(["codex", "claude", "gemini"]);
    expect(statuses.every((status) => !status.supported && status.fiveHour === null)).toBe(true);
  });

  it("선택한 공급사의 브라우저 대체 상태만 반환한다", async () => {
    const statuses = await getQuotaStatuses(["codex"]);
    expect(statuses.map((status) => status.provider)).toEqual(["codex"]);
  });

  it("선택 공급사만 네이티브 한도 명령에 전달한다", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.mocked(invoke).mockResolvedValueOnce([]);

    await getQuotaStatuses(["claude"]);

    expect(invoke).toHaveBeenCalledWith("quota_statuses", { providers: ["claude"] });
  });

  it("Claude 수집 상태는 비활성이고 설정 변경은 거부한다", async () => {
    await expect(getClaudeQuotaCaptureStatus()).resolves.toEqual({ configured: false, settingsPath: "", dataPath: "", hasData: false, existingStatusLine: false });
    await expect(configureClaudeQuotaCapture()).rejects.toThrow("데스크톱 앱");
  });
});
