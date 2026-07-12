// 매직링크 인증 콜백이 현재 기기에서 시작한 요청과 일치하는지 검증하는 테스트
import { describe, expect, it } from "vitest";
import { authRedirectCode, authRedirectWithState, createPkceChallenge, createPkcePair, verifyAuthRedirectState } from "./deep-link";

describe("auth deep-link state", () => {
  it("요청 nonce를 리디렉션에 넣고 일치하는 콜백만 허용한다", () => {
    const redirect = authRedirectWithState("nonce-1");
    expect(new URL(redirect).searchParams.get("state")).toBe("nonce-1");
    expect(() => verifyAuthRedirectState(`${redirect}#access_token=token`, "nonce-1")).not.toThrow();
    expect(() => verifyAuthRedirectState(`${redirect}#access_token=token`, "nonce-2")).toThrow("차단");
    expect(() => verifyAuthRedirectState("token-deck://auth#access_token=token", null)).toThrow("차단");
  });

  it("RFC 7636 S256 방식의 PKCE 검증값을 만든다", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(await createPkceChallenge(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    const generated = await createPkcePair();
    expect(generated.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generated.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("PKCE 인증 코드를 읽고 공급사 오류는 거부한다", () => {
    expect(authRedirectCode("token-deck://auth?state=nonce&code=one-time-code")).toBe("one-time-code");
    expect(() => authRedirectCode("token-deck://auth?state=nonce&error=access_denied")).toThrow("완료하지 못했습니다");
  });
});
