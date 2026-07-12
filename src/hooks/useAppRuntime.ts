// 로컬 수집, 계정 동기화, 공급사 사용량 조회를 하나의 앱 런타임으로 연결하는 훅
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UsageEvent as LocalUsageEvent } from "../core";
import { AUTH_PKCE_VERIFIER_KEY, AUTH_REDIRECT_URL, AUTH_STATE_KEY, authRedirectCode, authRedirectWithState, createPkcePair, listenForAuthDeepLinks, verifyAuthRedirectState } from "../platform/deep-link";
import { openExternalBrowser } from "../platform/external-browser";
import {
  fetchStoredProviderUsage,
  ACCOUNT_PROVIDER_DEVICE_ID,
  buildUsageViews,
  loadProviderSecret,
  mergeSessionTitles,
  providerRecordsToUsageEvents,
  parseProviderCredentials,
  removeProviderSecret,
  removeProviderSecretIfMarker,
  storeProviderSecret,
  SupabaseAuthService,
  SupabaseRestClient,
  toSyncUsageEvents,
  UsageSyncService,
  type CredentialProvider,
  type ProviderCredentials,
  type ProviderUsageRecord,
  type SupabaseSession,
  type SupabaseConfig,
  type UsageEvent as SyncUsageEvent,
  type DeviceRegistration,
  type UsageQuery,
  isSupabasePublicKey,
} from "../services";
import { getOrCreateDeviceId, useLocalUsage } from "./useLocalUsage";

const SESSION_KEY = "token-deck-supabase-session";
const TITLES_KEY = "token-deck-session-titles";
const CONFIG_KEY = "token-deck-supabase-config";

type AuthStatus = "local" | "signed_out" | "authenticated";
type CloudSyncStatus = "disabled" | "signed_out" | "idle" | "syncing" | "offline" | "error";

interface CredentialStatus { configured: boolean; checking: boolean; error?: string }

export function useAppRuntime() {
  const local = useLocalUsage();
  const [runtimeConfig, setRuntimeConfig] = useState<SupabaseConfig | null>(() => {
    const saved = readJson<SupabaseConfig | null>(CONFIG_KEY, null);
    return saved && isSecureSupabaseUrl(saved.url) && isSupabasePublicKey(saved.anonKey) ? saved : null;
  });
  const client = useMemo(() => new SupabaseRestClient(runtimeConfig ?? undefined), [runtimeConfig]);
  const authService = useMemo(() => new SupabaseAuthService(client), [client]);
  const syncService = useMemo(() => new UsageSyncService(client), [client]);
  const [auth, setAuth] = useState<{ enabled: boolean; status: AuthStatus; userId?: string; error?: string }>({
    enabled: client.enabled,
    status: client.enabled ? "signed_out" : "local",
  });
  const [cloudSync, setCloudSync] = useState<{ status: CloudSyncStatus; uploaded: number; pending: number; lastSyncedAt?: Date; error?: string }>({
    status: client.enabled ? "signed_out" : "disabled",
    uploaded: 0,
    pending: 0,
  });
  const [credentials, setCredentials] = useState<Record<CredentialProvider, CredentialStatus>>(() => emptyCredentialStatus());
  const [providerUsage, setProviderUsage] = useState<ProviderUsageRecord[]>([]);
  const [remoteEvents, setRemoteEvents] = useState<LocalUsageEvent[]>([]);
  const [remoteAccountEvents, setRemoteAccountEvents] = useState<SyncUsageEvent[]>([]);
  const [devices, setDevices] = useState<DeviceRegistration[]>(() => [currentDevice()]);
  const [providerEvents, setProviderEvents] = useState<SyncUsageEvent[]>([]);
  const [sessionTitles, setSessionTitles] = useState<Record<string, string>>(() => readJson(TITLES_KEY, {}));
  const syncingRef = useRef(false);
  const accountGenerationRef = useRef(0);
  const skipNextRestoreRef = useRef(false);

  const refreshCredentialStatus = useCallback(async () => {
    const providers: CredentialProvider[] = ["openai", "anthropic", "google"];
    setCredentials((current) => Object.fromEntries(providers.map((provider) => [provider, { ...current[provider], checking: true }])) as Record<CredentialProvider, CredentialStatus>);
    const results = await Promise.all(providers.map(async (provider) => {
      try {
        return [provider, { configured: Boolean(await loadProviderSecret(provider)), checking: false }] as const;
      } catch (cause) {
        return [provider, { configured: false, checking: false, error: message(cause) }] as const;
      }
    }));
    setCredentials(Object.fromEntries(results) as Record<CredentialProvider, CredentialStatus>);
  }, []);

  useEffect(() => { void refreshCredentialStatus(); }, [refreshCredentialStatus]);

  useEffect(() => {
    if (!client.enabled) return;
    if (skipNextRestoreRef.current) {
      skipNextRestoreRef.current = false;
      return;
    }
    const generation = accountGenerationRef.current;
    let cancelled = false;
    const restore = async () => {
      try {
        const saved = await loadStoredSession(sessionScope(client.config));
        if (!saved?.accessToken) return;
        const session = saved.expiresAt && saved.expiresAt <= Math.floor(Date.now() / 1000) + 30 && saved.refreshToken
          ? await authService.refresh(saved.refreshToken)
          : saved;
        if (cancelled || generation !== accountGenerationRef.current) return;
        authService.acceptSession(session);
        const marker = await persistSession(session, sessionScope(client.config));
        if (cancelled || generation !== accountGenerationRef.current) {
          await removePersistedSession(marker);
          return;
        }
        setAuth({ enabled: true, status: "authenticated", userId: session.userId ?? jwtSubject(session.accessToken) });
        setCloudSync((current) => ({ ...current, status: "idle", error: undefined }));
      } catch (cause) {
        if (cancelled || generation !== accountGenerationRef.current) return;
        window.localStorage.removeItem(SESSION_KEY);
        setAuth({ enabled: true, status: "signed_out", error: message(cause) });
      }
    };
    void restore();
    return () => { cancelled = true; };
  }, [authService, client]);

  const sendMagicLink = useCallback(async (email: string, redirectTo?: string) => {
    if (!client.enabled) throw new Error("Supabase 환경 설정이 없어 로컬 전용 모드입니다.");
    const state = crypto.randomUUID();
    window.localStorage.setItem(AUTH_STATE_KEY, state);
    window.localStorage.removeItem(AUTH_PKCE_VERIFIER_KEY);
    await authService.sendMagicLink(email, authRedirectWithState(state, redirectTo ?? AUTH_REDIRECT_URL));
  }, [authService, client.enabled]);

  const signInWithGoogle = useCallback(async () => {
    if (!client.enabled) throw new Error("Supabase 환경 설정이 없어 로컬 전용 모드입니다.");
    const state = crypto.randomUUID();
    const { verifier, challenge } = await createPkcePair();
    window.localStorage.setItem(AUTH_STATE_KEY, state);
    window.localStorage.setItem(AUTH_PKCE_VERIFIER_KEY, verifier);
    try {
      const redirectTo = authRedirectWithState(state, AUTH_REDIRECT_URL);
      await openExternalBrowser(authService.createGoogleOAuthUrl(redirectTo, challenge));
    } catch (cause) {
      if (window.localStorage.getItem(AUTH_STATE_KEY) === state) window.localStorage.removeItem(AUTH_STATE_KEY);
      if (window.localStorage.getItem(AUTH_PKCE_VERIFIER_KEY) === verifier) window.localStorage.removeItem(AUTH_PKCE_VERIFIER_KEY);
      throw cause;
    }
  }, [authService, client.enabled]);

  const acceptAuthRedirect = useCallback(async (url: string) => {
    const generation = accountGenerationRef.current;
    const scope = sessionScope(client.config);
    verifyAuthRedirectState(url, window.localStorage.getItem(AUTH_STATE_KEY));
    const codeVerifier = window.localStorage.getItem(AUTH_PKCE_VERIFIER_KEY) ?? "";
    window.localStorage.removeItem(AUTH_STATE_KEY);
    window.localStorage.removeItem(AUTH_PKCE_VERIFIER_KEY);
    const code = authRedirectCode(url);
    const session = code
      ? await authService.exchangeCodeForSession(code, codeVerifier)
      : authService.acceptRedirectUrl(url);
    const complete = { ...session, userId: session.userId ?? jwtSubject(session.accessToken) };
    authService.acceptSession(complete);
    if (generation !== accountGenerationRef.current || scope !== sessionScope(client.config)) return;
    const marker = await persistSession(complete, scope);
    if (generation !== accountGenerationRef.current || scope !== sessionScope(client.config)) {
      await removePersistedSession(marker);
      return;
    }
    setAuth({ enabled: true, status: "authenticated", userId: complete.userId });
    setCloudSync((current) => ({ ...current, status: "idle", error: undefined }));
  }, [authService, client.config?.url]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenForAuthDeepLinks(async (url) => {
      if (disposed) return;
      try {
        await acceptAuthRedirect(url.toString());
      } catch (cause) {
        if (!disposed) setAuth((current) => ({ ...current, error: message(cause) }));
      }
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    }).catch((cause) => setAuth((current) => ({ ...current, error: message(cause) })));
    return () => { disposed = true; unlisten?.(); };
  }, [acceptAuthRedirect]);

  const signOut = useCallback(async () => {
    accountGenerationRef.current += 1;
    syncingRef.current = false;
    authService.signOutLocally();
    window.localStorage.removeItem(SESSION_KEY);
    window.localStorage.removeItem(AUTH_STATE_KEY);
    window.localStorage.removeItem(AUTH_PKCE_VERIFIER_KEY);
    setAuth({ enabled: client.enabled, status: client.enabled ? "signed_out" : "local" });
    setRemoteEvents([]);
    setRemoteAccountEvents([]);
    setDevices([currentDevice()]);
    setCloudSync({ status: client.enabled ? "signed_out" : "disabled", uploaded: 0, pending: 0 });
    await removeProviderSecret("supabase").catch(() => undefined);
  }, [authService, client.enabled]);

  const syncNow = useCallback(async () => {
    const generation = accountGenerationRef.current;
    await local.refresh();
    if (generation !== accountGenerationRef.current) return;
    if (!client.enabled) {
      setCloudSync({ status: "disabled", uploaded: 0, pending: 0 });
      return;
    }
    if (!client.currentSession) {
      setCloudSync((current) => ({ ...current, status: "signed_out" }));
      return;
    }
    if (client.currentSession.expiresAt && client.currentSession.expiresAt <= Math.floor(Date.now() / 1000) + 30) {
      const refreshScope = sessionScope(client.config);
      const refreshToken = client.currentSession.refreshToken ?? (await loadStoredSession(sessionScope(client.config)))?.refreshToken;
      if (generation !== accountGenerationRef.current) return;
      if (!refreshToken) {
        void signOut();
        setAuth({ enabled: true, status: "signed_out", error: "로그인 세션이 만료되었습니다." });
        return;
      }
      try {
        const refreshed = await authService.refresh(refreshToken);
        if (generation !== accountGenerationRef.current || refreshScope !== sessionScope(client.config)) return;
        const marker = await persistSession(refreshed, refreshScope);
        if (generation !== accountGenerationRef.current || refreshScope !== sessionScope(client.config)) {
          await removePersistedSession(marker);
          return;
        }
        setAuth({ enabled: true, status: "authenticated", userId: refreshed.userId ?? jwtSubject(refreshed.accessToken) });
      } catch (cause) {
        setAuth((current) => ({ ...current, error: message(cause) }));
        return;
      }
    }
    if (syncingRef.current) return;
    const titled = toSyncUsageEvents(local.events).map((event) => ({ ...event, sessionTitle: event.sessionId ? sessionTitles[event.sessionId] : undefined }));
    const outgoing = deduplicateSyncEvents([...titled, ...providerEvents]);
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setCloudSync((current) => ({ ...current, status: "offline", pending: outgoing.length, error: "네트워크가 복구되면 자동으로 다시 시도합니다." }));
      return;
    }
    syncingRef.current = true;
    setCloudSync((current) => ({ ...current, status: "syncing", pending: outgoing.length, error: undefined }));
    try {
      const deviceResult = await syncService.registerDevice({
        id: getOrCreateDeviceId(),
        name: typeof navigator !== "undefined" ? navigator.platform || "Windows 기기" : "Windows 기기",
        platform: "windows",
        appVersion: "0.3.0",
        lastSeenAt: new Date().toISOString(),
      });
      if (deviceResult.error) throw new Error(deviceResult.error);
      if (providerEvents.length) {
        const accountDeviceResult = await syncService.registerDevice({
          id: ACCOUNT_PROVIDER_DEVICE_ID,
          name: "계정 API 집계",
          platform: "account",
          appVersion: "0.3.0",
          lastSeenAt: new Date().toISOString(),
        });
        if (accountDeviceResult.error) throw new Error(accountDeviceResult.error);
      }
      const result = await syncService.upsertUsageEvents(outgoing);
      if (result.error) throw new Error(result.error);
      const [downloaded, accountDevices] = await Promise.all([syncService.listUsageEvents(), syncService.listDevices()]);
      if (generation !== accountGenerationRef.current) return;
      setRemoteEvents(downloaded.flatMap(toLocalUsageEvent));
      setRemoteAccountEvents(downloaded.filter((event) => event.source === "provider_api" || event.source === "cloud_billing"));
      const mergedTitles = mergeSessionTitles(sessionTitles, downloaded);
      setSessionTitles(mergedTitles);
      window.localStorage.setItem(TITLES_KEY, JSON.stringify(mergedTitles));
      const physicalDevices = accountDevices.filter((device) => device.id !== ACCOUNT_PROVIDER_DEVICE_ID);
      setDevices(physicalDevices.length ? physicalDevices : [currentDevice()]);
      setCloudSync({ status: "idle", uploaded: result.uploaded, pending: 0, lastSyncedAt: new Date() });
    } catch (cause) {
      if (generation !== accountGenerationRef.current) return;
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      setCloudSync((current) => ({ ...current, status: offline ? "offline" : "error", pending: outgoing.length, error: message(cause) }));
    } finally {
      if (generation === accountGenerationRef.current) syncingRef.current = false;
    }
  }, [authService, client, local.events, local.refresh, providerEvents, sessionTitles, signOut, syncService]);

  useEffect(() => {
    if (auth.status !== "authenticated") return;
    const retry = () => void syncNow();
    window.addEventListener("online", retry);
    const timer = window.setInterval(retry, 60_000);
    void syncNow();
    return () => { window.removeEventListener("online", retry); window.clearInterval(timer); };
  }, [auth.status, syncNow]);

  const saveProviderCredential = useCallback(async (provider: CredentialProvider, value: ProviderCredentials | Record<string, string>) => {
    parseProviderCredentials(provider, JSON.stringify(value));
    await storeProviderSecret(provider, JSON.stringify(value));
    await refreshCredentialStatus();
  }, [refreshCredentialStatus]);

  const removeProviderCredential = useCallback(async (provider: CredentialProvider) => {
    await removeProviderSecret(provider);
    setProviderUsage((current) => current.filter((item) => item.provider !== provider));
    setProviderEvents((current) => current.filter((item) => item.provider !== provider));
    await refreshCredentialStatus();
  }, [refreshCredentialStatus]);

  const refreshProviderUsage = useCallback(async (provider: CredentialProvider, query: UsageQuery = defaultQuery()) => {
    const records = await fetchStoredProviderUsage(provider, query);
    const converted = providerRecordsToUsageEvents(records, getOrCreateDeviceId());
    setProviderUsage((current) => [...current.filter((item) => item.provider !== provider), ...records]);
    setProviderEvents((current) => deduplicateSyncEvents([...current.filter((item) => item.provider !== provider), ...converted]));
    return converted;
  }, []);

  const refreshProviderUsageForUi = useCallback(async (provider: CredentialProvider, query?: UsageQuery): Promise<void> => {
    await refreshProviderUsage(provider, query);
  }, [refreshProviderUsage]);

  const updateSessionTitle = useCallback(async (sessionId: string, title: string) => {
    const next = { ...sessionTitles };
    const normalized = title.trim();
    if (normalized) next[sessionId] = normalized;
    else delete next[sessionId];
    setSessionTitles(next);
    window.localStorage.setItem(TITLES_KEY, JSON.stringify(next));
  }, [sessionTitles]);

  const configureSupabase = useCallback(async (url: string, publishableKey: string) => {
    const normalizedUrl = url.trim().replace(/\/+$/, "");
    const normalizedKey = publishableKey.trim();
    if (!isSecureSupabaseUrl(normalizedUrl) || !isSupabasePublicKey(normalizedKey)) throw new Error("HTTPS Supabase URL과 publishable key가 필요합니다. secret 또는 service_role key는 저장할 수 없습니다.");
    const config = { url: normalizedUrl, anonKey: normalizedKey };
    accountGenerationRef.current += 1;
    syncingRef.current = false;
    skipNextRestoreRef.current = true;
    authService.signOutLocally();
    window.localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    window.localStorage.removeItem(SESSION_KEY);
    window.localStorage.removeItem(AUTH_STATE_KEY);
    window.localStorage.removeItem(AUTH_PKCE_VERIFIER_KEY);
    await removeProviderSecret("supabase").catch(() => undefined);
    setRuntimeConfig(config);
    setRemoteEvents([]);
    setRemoteAccountEvents([]);
    setDevices([currentDevice()]);
    setAuth({ enabled: true, status: "signed_out" });
    setCloudSync({ status: "signed_out", uploaded: 0, pending: 0 });
  }, [authService]);

  const clearSupabaseConfig = useCallback(async () => {
    accountGenerationRef.current += 1;
    syncingRef.current = false;
    authService.signOutLocally();
    window.localStorage.removeItem(CONFIG_KEY);
    window.localStorage.removeItem(SESSION_KEY);
    window.localStorage.removeItem(AUTH_STATE_KEY);
    window.localStorage.removeItem(AUTH_PKCE_VERIFIER_KEY);
    await removeProviderSecret("supabase").catch(() => undefined);
    setRuntimeConfig(null);
    setRemoteEvents([]);
    setRemoteAccountEvents([]);
    setDevices([currentDevice()]);
    setAuth({ enabled: false, status: "local" });
    setCloudSync({ status: "disabled", uploaded: 0, pending: 0 });
  }, [authService]);

  const usageViews = useMemo(() => {
    const currentProviderEvents = providerEvents.flatMap(toLocalUsageEvent);
    const cloudEvents = [...remoteEvents, ...currentProviderEvents];
    return buildUsageViews(local.events, cloudEvents);
  }, [local.events, providerEvents, remoteEvents]);
  const accountProviderUsage = useMemo(
    () => mergeAccountProviderUsage(remoteAccountEvents, providerUsage),
    [providerUsage, remoteAccountEvents],
  );

  return {
    ...local,
    events: usageViews.combinedEvents,
    combinedEvents: usageViews.combinedEvents,
    localSessionEvents: usageViews.localSessionEvents,
    accountProviderEvents: usageViews.accountProviderEvents,
    auth,
    cloudSync,
    credentials,
    providerUsage: accountProviderUsage,
    devices,
    sessionTitles,
    sendMagicLink,
    signInWithGoogle,
    acceptAuthRedirect,
    signOut,
    syncNow,
    saveProviderCredential,
    removeProviderCredential,
    refreshCredentialStatus,
    refreshProviderUsage: refreshProviderUsageForUi,
    updateSessionTitle,
    configureSupabase,
    clearSupabaseConfig,
  };
}

function emptyCredentialStatus(): Record<CredentialProvider, CredentialStatus> {
  return { openai: { configured: false, checking: false }, anthropic: { configured: false, checking: false }, google: { configured: false, checking: false } };
}
function currentDevice(): DeviceRegistration {
  return {
    id: getOrCreateDeviceId(),
    name: typeof navigator !== "undefined" ? navigator.platform || "Windows 기기" : "Windows 기기",
    platform: "windows",
    appVersion: "0.3.0",
    lastSeenAt: new Date().toISOString(),
  };
}
function defaultQuery(): UsageQuery {
  const endTime = new Date();
  const startTime = new Date(endTime);
  startTime.setDate(startTime.getDate() - 30);
  return { startTime, endTime };
}
async function persistSession(session: SupabaseSession, scope?: string): Promise<string> {
  if (!scope) throw new Error("Supabase 세션을 저장할 서버 설정이 없습니다.");
  const marker = crypto.randomUUID();
  await storeProviderSecret("supabase", JSON.stringify({ scope, session, marker }));
  window.localStorage.removeItem(SESSION_KEY);
  return marker;
}

async function removePersistedSession(marker: string): Promise<void> {
  await removeProviderSecretIfMarker("supabase", marker).catch(() => undefined);
}
async function loadStoredSession(scope?: string): Promise<SupabaseSession | null> {
  if (!scope) return null;
  const secure = await loadProviderSecret("supabase").catch(() => undefined);
  if (secure) {
    try {
      const parsed = JSON.parse(secure) as { scope?: string; session?: SupabaseSession };
      if (parsed.scope === scope && parsed.session?.accessToken) return parsed.session;
      return null;
    } catch {
      const legacy = readJson<SupabaseSession | null>(SESSION_KEY, null);
      if (legacy?.accessToken) return { ...legacy, refreshToken: secure };
    }
  }
  return readJson<SupabaseSession | null>(SESSION_KEY, null);
}

function sessionScope(config: SupabaseConfig | null): string | undefined {
  return config ? `${config.url}\n${config.anonKey}` : undefined;
}

function isSecureSupabaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  } catch {
    return false;
  }
}
function readJson<T>(key: string, fallback: T): T {
  try { return JSON.parse(window.localStorage.getItem(key) ?? "") as T; } catch { return fallback; }
}
function jwtSubject(token: string): string | undefined {
  try { return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sub; } catch { return undefined; }
}
function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
function deduplicateSyncEvents(events: SyncUsageEvent[]): SyncUsageEvent[] { return [...new Map(events.map((event) => [event.eventId, event])).values()]; }
export function mergeAccountProviderUsage(remote: SyncUsageEvent[], current: ProviderUsageRecord[]): ProviderUsageRecord[] {
  const byBucket = new Map<string, { record: ProviderUsageRecord; priority: number }>();
  for (const event of remote) {
    const record = syncEventToProviderUsage(event);
    if (!record) continue;
    const key = providerUsageBucketKey(record);
    const priority = event.eventId.length;
    if (!byBucket.has(key) || priority >= (byBucket.get(key)?.priority ?? 0)) byBucket.set(key, { record, priority });
  }
  for (const record of current) byBucket.set(providerUsageBucketKey(record), { record, priority: Number.MAX_SAFE_INTEGER });
  return [...byBucket.values()].map((item) => item.record);
}
function syncEventToProviderUsage(event: SyncUsageEvent): ProviderUsageRecord | undefined {
  if (event.source !== "provider_api" && event.source !== "cloud_billing") return undefined;
  const provider = ({ openai: "openai", codex: "openai", anthropic: "anthropic", claude: "anthropic", google: "google", gemini: "google" } as const)[event.provider];
  if (!provider) return undefined;
  return {
    provider,
    kind: event.source === "cloud_billing" ? "cost" : "tokens",
    occurredAt: event.occurredAt,
    projectRef: event.projectId,
    model: event.model,
    inputTokens: event.inputTokens,
    cachedTokens: event.cachedTokens,
    outputTokens: event.outputTokens,
    amount: typeof event.metadata?.amount === "number" ? event.metadata.amount : undefined,
    currency: typeof event.metadata?.currency === "string" ? event.metadata.currency : undefined,
    raw: { eventId: event.eventId, source: "synced" },
  };
}
function providerUsageBucketKey(record: ProviderUsageRecord): string {
  return [record.provider, record.kind, record.occurredAt, record.projectRef ?? "", record.model ?? "", record.currency ?? ""].join("\u001f");
}
function toLocalUsageEvent(event: SyncUsageEvent): LocalUsageEvent[] {
  if (event.source === "cloud_billing") return [];
  const provider = ({ openai: "codex", anthropic: "claude", google: "gemini", codex: "codex", claude: "claude", gemini: "gemini" } as const)[event.provider];
  const tokenCount = event.inputTokens + event.cachedTokens + event.outputTokens + event.reasoningTokens + event.toolTokens;
  if (!provider || tokenCount === 0) return [];
  return [{
    id: event.eventId,
    provider,
    source: event.source === "provider_api" ? "provider-api" : "local-jsonl",
    deviceId: event.deviceId,
    sessionId: event.sessionId ?? `provider_${event.provider}_${event.occurredAt.slice(0, 10)}`,
    projectId: event.projectId ?? `provider_${event.provider}_account`,
    model: event.model,
    occurredAt: event.occurredAt,
    tokens: { input: event.inputTokens, cached: event.cachedTokens, output: event.outputTokens, reasoning: event.reasoningTokens, tool: event.toolTokens },
  }];
}
