// 로그인 화면 복귀 시 로그아웃과 온보딩 초기화 순서를 검증한다
import { describe, expect, it, vi } from "vitest";
import { ONBOARDING_COMPLETE_KEY, prepareLoginScreen } from "./onboarding-state";

describe("prepareLoginScreen", () => {
  it("인증된 계정은 로그아웃을 마친 뒤 로그인 화면 상태를 초기화한다", async () => {
    const order: string[] = [];
    const signOut = vi.fn(async () => { order.push("sign-out"); });
    const storage = { removeItem: vi.fn(() => { order.push("reset-onboarding"); }) };

    await prepareLoginScreen("authenticated", signOut, storage);

    expect(signOut).toHaveBeenCalledOnce();
    expect(storage.removeItem).toHaveBeenCalledWith(ONBOARDING_COMPLETE_KEY);
    expect(order).toEqual(["sign-out", "reset-onboarding"]);
  });

  it("로그아웃 상태에서는 원격 로그아웃 없이 로그인 화면 상태만 초기화한다", async () => {
    const signOut = vi.fn();
    const storage = { removeItem: vi.fn() };

    await prepareLoginScreen("signed_out", signOut, storage);

    expect(signOut).not.toHaveBeenCalled();
    expect(storage.removeItem).toHaveBeenCalledWith(ONBOARDING_COMPLETE_KEY);
  });
});
