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
});
