// 매직링크 리디렉션과 세션 갱신 계약을 검증하는 테스트
import { describe, expect, it, vi } from "vitest";
import { AUTH_REDIRECT_URL } from "../../platform/deep-link";
import { SupabaseAuthService } from "./auth";
import { SupabaseRestClient } from "./client";

describe("SupabaseAuthService", () => {
  it("Google 공급자가 비활성 상태면 외부 로그인 전에 명확하게 중단한다", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ external: { google: false } }), { status: 200 }));
    const client = new SupabaseRestClient({ url: "https://example.supabase.co", anonKey: "publishable" }, request);

    await expect(new SupabaseAuthService(client).ensureGoogleProviderEnabled())
      .rejects.toThrow("현재 동기화 서버에서 Google 로그인이 활성화되지 않았습니다");

    expect(request.mock.calls[0][0]).toBe("https://example.supabase.co/auth/v1/settings");
    expect((request.mock.calls[0][1] as RequestInit).method).toBe("GET");
  });

  it("Google 공급자가 활성 상태면 로그인을 계속할 수 있다", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ external: { google: true } }), { status: 200 }));
    const client = new SupabaseRestClient({ url: "https://example.supabase.co", anonKey: "publishable" }, request);

    await expect(new SupabaseAuthService(client).ensureGoogleProviderEnabled()).resolves.toBeUndefined();
  });

  it("매직링크 요청에 데스크톱 인증 딥링크를 포함한다", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new SupabaseRestClient({ url: "https://example.supabase.co", anonKey: "anon" }, request);

    await new SupabaseAuthService(client).sendMagicLink("USER@example.com", AUTH_REDIRECT_URL, "c".repeat(43));

    expect(request.mock.calls[0][0]).toBe(`https://example.supabase.co/auth/v1/otp?redirect_to=${encodeURIComponent(AUTH_REDIRECT_URL)}`);
    expect(JSON.parse(String((request.mock.calls[0][1] as RequestInit).body))).toEqual({
      email: "user@example.com",
      create_user: true,
      code_challenge: "c".repeat(43),
      code_challenge_method: "s256",
    });
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
    expect(client.currentSession).toBeNull();
  });

  it("갱신과 레거시 implicit 해석은 저장 전 클라이언트 세션을 바꾸지 않는다", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, user: { id: "user-2" },
    }), { status: 200 }));
    const client = new SupabaseRestClient({ url: "https://example.supabase.co", anonKey: "publishable" }, request);
    const auth = new SupabaseAuthService(client);
    const existing = { accessToken: "existing-access", refreshToken: "existing-refresh", userId: "user-1" };
    auth.acceptSession(existing);

    const refreshed = await auth.refresh("old-refresh");
    const implicit = auth.acceptRedirectUrl("token-deck://auth#access_token=legacy&refresh_token=legacy-refresh&expires_in=60");

    expect(refreshed).toEqual(expect.objectContaining({ accessToken: "new-access", userId: "user-2" }));
    expect(implicit).toEqual(expect.objectContaining({ accessToken: "legacy", refreshToken: "legacy-refresh" }));
    expect(client.currentSession).toEqual(existing);
  });

  it("현재 승인된 세션으로 Supabase 로그아웃 API를 호출한다", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new SupabaseRestClient({ url: "https://example.supabase.co", anonKey: "publishable" }, request);
    const auth = new SupabaseAuthService(client);
    auth.acceptSession({ accessToken: "active-access", refreshToken: "active-refresh" });
    const controller = new AbortController();

    await auth.signOutRemotely(controller.signal);

    expect(request.mock.calls[0][0]).toBe("https://example.supabase.co/auth/v1/logout?scope=local");
    const requestInit = request.mock.calls[0][1] as RequestInit;
    const headers = new Headers(requestInit.headers);
    expect(headers.get("Authorization")).toBe("Bearer active-access");
    expect(requestInit.signal).toBe(controller.signal);
  });
});
