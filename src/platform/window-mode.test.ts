// 미니모드 프레임과 핀 상태가 창 설정으로 정확히 변환되는지 검증한다
import { describe, expect, it } from "vitest";
import { getWindowModeSpec } from "./window-mode";

describe("getWindowModeSpec", () => {
  it("미니모드는 프레임을 제거하지만 기본으로 항상 위를 강제하지 않는다", () => {
    expect(getWindowModeSpec(true)).toEqual({
      width: 430,
      height: 360,
      minWidth: 430,
      minHeight: 360,
      decorations: false,
      alwaysOnTop: false,
    });
  });

  it("핀 상태만 항상 위 동작을 활성화한다", () => {
    expect(getWindowModeSpec(true, true).alwaysOnTop).toBe(true);
    expect(getWindowModeSpec(false, false).alwaysOnTop).toBe(false);
  });

  it("일반모드로 돌아가면 제목 표시줄과 프레임을 복원한다", () => {
    expect(getWindowModeSpec(false)).toEqual({
      width: 1280,
      height: 820,
      minWidth: 920,
      minHeight: 640,
      decorations: true,
      alwaysOnTop: false,
    });
  });
});
