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

  async sendMagicLink(email: string, redirectTo: string | undefined, codeChallenge: string): Promise<void> {
    const normalized = email.trim().toLowerCase();
    if (!normalized || !normalized.includes("@")) throw new Error("유효한 이메일 주소가 필요합니다.");
    if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) throw new Error("이메일 로그인 PKCE 검증값이 올바르지 않습니다.");

    const path = redirectTo
      ? `/auth/v1/otp?redirect_to=${encodeURIComponent(redirectTo)}`
      : "/auth/v1/otp";
    await this.client.call<void>(path, {
      method: "POST",
      body: JSON.stringify({
        email: normalized,
        create_user: true,
        code_challenge: codeChallenge,
        code_challenge_method: "s256",
      }),
    }, { auth: false });
  }

  createGoogleOAuthUrl(redirectTo: string, codeChallenge: string): string {
    if (!this.client.config) throw new Error("Supabase 환경 설정이 없어 Google 로그인을 시작할 수 없습니다.");
    if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) throw new Error("Google 로그인 PKCE 검증값이 올바르지 않습니다.");
    const redirect = new URL(redirectTo);
    if (redirect.protocol !== "token-deck:" || redirect.hostname !== "auth") {
      throw new Error("Google 로그인 콜백 주소가 올바르지 않습니다.");
    }
    const authorize = new URL(`${this.client.config.url}/auth/v1/authorize`);
    authorize.searchParams.set("provider", "google");
    authorize.searchParams.set("redirect_to", redirect.toString());
    authorize.searchParams.set("code_challenge", codeChallenge);
    authorize.searchParams.set("code_challenge_method", "s256");
    return authorize.toString();
  }

  async exchangeCodeForSession(authCode: string, codeVerifier: string): Promise<SupabaseSession> {
    if (!authCode.trim()) throw new Error("로그인 콜백에 인증 코드가 없습니다.");
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) throw new Error("로그인 PKCE 검증 정보를 찾을 수 없습니다. 로그인을 다시 시작해 주세요.");
    const response = await this.client.call<AuthResponse>("/auth/v1/token?grant_type=pkce", {
      method: "POST",
      body: JSON.stringify({ auth_code: authCode, code_verifier: codeVerifier }),
    }, { auth: false });
    return toSession(response);
  }

  // 기존 implicit 콜백을 해석해야 하는 호환 경로이며 클라이언트 세션은 절대 변경하지 않습니다.
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
    return toSession(response);
  }

  async signOutRemotely(): Promise<void> {
    if (!this.client.currentSession) return;
    await this.client.call<void>("/auth/v1/logout", { method: "POST" });
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
