// 매직링크 리디렉션과 세션 갱신 계약을 검증하는 테스트
import { describe, expect, it, vi } from "vitest";
import { AUTH_REDIRECT_URL } from "../../platform/deep-link";
import { SupabaseAuthService } from "./auth";
import { SupabaseRestClient } from "./client";

describe("SupabaseAuthService", () => {
  it("매직링크 요청에 데스크톱 인증 딥링크를 포함한다", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new SupabaseRestClient({ url: "https://example.supabase.co", anonKey: "anon" }, request);

    await new SupabaseAuthService(client).sendMagicLink("USER@example.com", AUTH_REDIRECT_URL);

    expect(request.mock.calls[0][0]).toBe(`https://example.supabase.co/auth/v1/otp?redirect_to=${encodeURIComponent(AUTH_REDIRECT_URL)}`);
    expect(JSON.parse(String((request.mock.calls[0][1] as RequestInit).body))).toEqual({ email: "user@example.com", create_user: true });
  });

  it("Google OAuth 주소에 딥링크와 PKCE S256 값을 포함한다", () => {
    const client = new SupabaseRestClient({ url: "https://example.supabase.co", anonKey: "publishable" });
    const authorize = new URL(new SupabaseAuthService(client).createGoogleOAuthUrl(
      "token-deck://auth?state=nonce-1",
      "a".repeat(43),
    ));

    expect(authorize.origin + authorize.pathname).toBe("https://example.supabase.co/auth/v1/authorize");
    expect(Object.fromEntries(authorize.searchParams)).toEqual({
      provider: "google",
      redirect_to: "token-deck://auth?state=nonce-1",
      code_challenge: "a".repeat(43),
      code_challenge_method: "s256",
    });
  });

  it("일회용 인증 코드와 같은 기기의 verifier로 세션을 교환한다", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: "access", refresh_token: "refresh", expires_in: 3600, user: { id: "user-1" },
    }), { status: 200 }));
    const client = new SupabaseRestClient({ url: "https://example.supabase.co", anonKey: "publishable" }, request);

    const session = await new SupabaseAuthService(client).exchangeCodeForSession("one-time-code", "v".repeat(43));

    expect(request.mock.calls[0][0]).toBe("https://example.supabase.co/auth/v1/token?grant_type=pkce");
    expect(JSON.parse(String((request.mock.calls[0][1] as RequestInit).body))).toEqual({ auth_code: "one-time-code", code_verifier: "v".repeat(43) });
    expect(session).toEqual(expect.objectContaining({ accessToken: "access", refreshToken: "refresh", userId: "user-1" }));
  });
});
