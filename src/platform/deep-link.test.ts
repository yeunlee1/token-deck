// 매직링크 인증 콜백이 현재 기기에서 시작한 요청과 일치하는지 검증하는 테스트
import { describe, expect, it } from "vitest";
import { authRedirectWithState, verifyAuthRedirectState } from "./deep-link";

describe("auth deep-link state", () => {
  it("요청 nonce를 리디렉션에 넣고 일치하는 콜백만 허용한다", () => {
    const redirect = authRedirectWithState("nonce-1");
    expect(new URL(redirect).searchParams.get("state")).toBe("nonce-1");
    expect(() => verifyAuthRedirectState(`${redirect}#access_token=token`, "nonce-1")).not.toThrow();
    expect(() => verifyAuthRedirectState(`${redirect}#access_token=token`, "nonce-2")).toThrow("차단");
    expect(() => verifyAuthRedirectState("token-deck://auth#access_token=token", null)).toThrow("차단");
  });
});
