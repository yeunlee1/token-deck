// 운영용 공개 키 기본값과 비밀 키 차단 규칙을 검증하는 테스트
import { describe, expect, it } from "vitest";
import { isSupabasePublicKey, readSupabaseConfig } from "./client";

describe("Supabase public configuration", () => {
  it("publishable key를 레거시 anon key보다 우선한다", () => {
    expect(readSupabaseConfig({
      VITE_SUPABASE_URL: "https://project.supabase.co/",
      VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_current",
      VITE_SUPABASE_ANON_KEY: "legacy-anon",
    })).toEqual({ url: "https://project.supabase.co", anonKey: "sb_publishable_current" });
  });

  it("secret key와 service_role JWT를 클라이언트 설정에서 차단한다", () => {
    const serviceRole = jwtWithRole("service_role");
    const anon = jwtWithRole("anon");
    expect(isSupabasePublicKey("sb_secret_server_only")).toBe(false);
    expect(isSupabasePublicKey("plain-publishable")).toBe(false);
    expect(isSupabasePublicKey(serviceRole)).toBe(false);
    expect(isSupabasePublicKey(anon)).toBe(true);
    expect(isSupabasePublicKey("sb_publishable_browser_safe")).toBe(true);
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: "https://project.supabase.co", VITE_SUPABASE_PUBLISHABLE_KEY: serviceRole })).toBeNull();
  });
});

function jwtWithRole(role: string): string {
  return `header.${btoa(JSON.stringify({ role }))}.signature`;
}
