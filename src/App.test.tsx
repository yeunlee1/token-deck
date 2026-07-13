// 로컬 모드 대시보드에서 로그인 화면으로 돌아가는 직접 진입 버튼을 검증한다
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { dashboardConnectionLabels, LoginScreenEntry } from "./App";

describe("LoginScreenEntry", () => {
  it("로컬 모드에서는 로그인 화면 복귀 버튼을 직접 보여준다", () => {
    const markup = renderToStaticMarkup(<LoginScreenEntry authenticated={false} onReturnToLogin={vi.fn()} />);

    expect(markup).toContain("로그인 화면으로 돌아가기");
    expect(markup).toContain('type="button"');
  });

  it("로그인된 상태에서는 중복 복귀 버튼을 숨긴다", () => {
    const markup = renderToStaticMarkup(<LoginScreenEntry authenticated onReturnToLogin={vi.fn()} />);

    expect(markup).toBe("");
  });
});

describe("dashboardConnectionLabels", () => {
  it("로그인 없이 시작한 signed_out 상태를 로컬 전용으로 표시한다", () => {
    expect(dashboardConnectionLabels(true, "signed_out", true, "signed_out")).toEqual({
      accountMeta: "로컬 전용 사용 중",
      syncHealth: "LOCAL",
    });
  });

  it("인증된 계정은 실제 동기화 상태를 표시한다", () => {
    expect(dashboardConnectionLabels(true, "authenticated", true, "idle")).toEqual({
      accountMeta: "여러 기기 동기화 활성",
      syncHealth: "IDLE",
    });
  });
});
