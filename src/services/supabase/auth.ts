// 이메일 매직링크와 세션 갱신을 처리하는 Supabase 인증 서비스
import { SupabaseRestClient, type SupabaseSession } from "./client";

interface AuthResponse {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  expires_in?: number;
  user?: { id?: string };
}

export class SupabaseAuthService {
  constructor(private readonly client: SupabaseRestClient) {}

  get enabled(): boolean {
    return this.client.enabled;
  }

  async sendMagicLink(email: string, redirectTo?: string): Promise<void> {
    const normalized = email.trim().toLowerCase();
    if (!normalized || !normalized.includes("@")) throw new Error("유효한 이메일 주소가 필요합니다.");

    const path = redirectTo
      ? `/auth/v1/otp?redirect_to=${encodeURIComponent(redirectTo)}`
      : "/auth/v1/otp";
    await this.client.call<void>(path, {
      method: "POST",
      body: JSON.stringify({
        email: normalized,
        create_user: true,
      }),
    }, { auth: false });
  }

  acceptRedirectUrl(url: string): SupabaseSession {
    const parsed = new URL(url);
    const values = new URLSearchParams(parsed.hash.replace(/^#/, ""));
    const accessToken = values.get("access_token") ?? parsed.searchParams.get("access_token");
    if (!accessToken) throw new Error("매직링크 콜백에 액세스 토큰이 없습니다.");
    const expiresIn = Number(values.get("expires_in") ?? parsed.searchParams.get("expires_in"));
    const session: SupabaseSession = {
      accessToken,
      refreshToken: values.get("refresh_token") ?? parsed.searchParams.get("refresh_token") ?? undefined,
      expiresAt: Number.isFinite(expiresIn) ? Math.floor(Date.now() / 1000) + expiresIn : undefined,
    };
    this.client.setSession(session);
    return session;
  }

  acceptSession(session: SupabaseSession): void {
    this.client.setSession(session);
  }

  async refresh(refreshToken: string): Promise<SupabaseSession> {
    const response = await this.client.call<AuthResponse>("/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      body: JSON.stringify({ refresh_token: refreshToken }),
    }, { auth: false });
    const session = toSession(response);
    this.client.setSession(session);
    return session;
  }

  signOutLocally(): void {
    this.client.setSession(null);
  }
}

function toSession(response: AuthResponse): SupabaseSession {
  if (!response.access_token) throw new Error("Supabase 인증 응답에 액세스 토큰이 없습니다.");
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: response.expires_at ?? (response.expires_in ? Math.floor(Date.now() / 1000) + response.expires_in : undefined),
    userId: response.user?.id,
  };
}
