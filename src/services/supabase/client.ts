// 환경 설정이 없으면 안전하게 비활성화되는 Supabase REST 클라이언트
export interface SupabaseConfig {
  url: string;
  // 기존 저장 형식과 호환되는 이름이며 publishable key 또는 레거시 anon key만 허용합니다.
  anonKey: string;
}

export interface SupabaseSession {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  userId?: string;
}

export class SupabaseRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "SupabaseRequestError";
  }
}

function cleanUrl(value?: string): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

export function readSupabaseConfig(
  env: Record<string, string | undefined> = (import.meta as ImportMeta & {
    env?: Record<string, string | undefined>;
  }).env ?? {},
): SupabaseConfig | null {
  const url = cleanUrl(env.VITE_SUPABASE_URL);
  const anonKey = (env.VITE_SUPABASE_PUBLISHABLE_KEY ?? env.VITE_SUPABASE_ANON_KEY ?? "").trim();
  return url && isSupabasePublicKey(anonKey) ? { url, anonKey } : null;
}

export function isSupabasePublicKey(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const key = value.trim();
  if (!key || key.startsWith("sb_secret_")) return false;
  const role = jwtRole(key);
  return role !== "service_role";
}

export class SupabaseRestClient {
  private session: SupabaseSession | null = null;

  constructor(
    readonly config: SupabaseConfig | null = readSupabaseConfig(),
    private readonly request: typeof fetch = fetch,
  ) {}

  get enabled(): boolean {
    return this.config !== null;
  }

  get currentSession(): SupabaseSession | null {
    return this.session;
  }

  setSession(session: SupabaseSession | null): void {
    this.session = session;
  }

  async call<T>(
    path: string,
    init: RequestInit = {},
    options: { auth?: boolean } = {},
  ): Promise<T> {
    if (!this.config) {
      throw new SupabaseRequestError("Supabase 동기화가 설정되지 않았습니다.", 0);
    }

    const token = options.auth === false ? this.config.anonKey : this.session?.accessToken;
    if (options.auth !== false && !token) {
      throw new SupabaseRequestError("Supabase 로그인이 필요합니다.", 401);
    }

    const headers = new Headers(init.headers);
    headers.set("apikey", this.config.anonKey);
    headers.set("Authorization", `Bearer ${token}`);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

    const response = await this.request(`${this.config.url}${path}`, { ...init, headers });
    const text = await response.text();
    const body = text ? safeJson(text) : undefined;
    if (!response.ok) {
      throw new SupabaseRequestError(`Supabase 요청 실패 (${response.status})`, response.status, body);
    }
    return body as T;
  }
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function jwtRole(value: string): string | undefined {
  const payload = value.split(".")[1];
  if (!payload) return undefined;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    return JSON.parse(atob(normalized)).role;
  } catch {
    return undefined;
  }
}
