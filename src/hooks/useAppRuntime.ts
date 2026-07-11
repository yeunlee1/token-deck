// 로컬 수집, 계정 동기화, 공급사 사용량 조회를 하나의 앱 런타임으로 연결하는 훅
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UsageEvent as LocalUsageEvent } from "../core";
import { AUTH_REDIRECT_URL, listenForAuthDeepLinks } from "../platform/deep-link";
import {
  fetchStoredProviderUsage,
  loadProviderSecret,
  mergeUsageWithProviderAuthority,
  mergeSessionTitles,
  providerRecordsToUsageEvents,
  parseProviderCredentials,
  removeProviderSecret,
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
  const [runtimeConfig, setRuntimeConfig] = useState<SupabaseConfig | null>(() => readJson(CONFIG_KEY, null));
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
  const [devices, setDevices] = useState<DeviceRegistration[]>(() => [currentDevice()]);
  const [providerEvents, setProviderEvents] = useState<SyncUsageEvent[]>([]);
  const [sessionTitles, setSessionTitles] = useState<Record<string, string>>(() => readJson(TITLES_KEY, {}));
  const syncingRef = useRef(false);

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
    const restore = async () => {
      try {
        const saved = await loadStoredSession();
        if (!saved?.accessToken) return;
        const session = saved.expiresAt && saved.expiresAt <= Math.floor(Date.now() / 1000) + 30 && saved.refreshToken
          ? await authService.refresh(saved.refreshToken)
          : saved;
        authService.acceptSession(session);
        await persistSession(session);
        setAuth({ enabled: true, status: "authenticated", userId: session.userId ?? jwtSubject(session.accessToken) });
        setCloudSync((current) => ({ ...current, status: "idle", error: undefined }));
      } catch (cause) {
        window.localStorage.removeItem(SESSION_KEY);
        setAuth({ enabled: true, status: "signed_out", error: message(cause) });
      }
    };
    void restore();
  }, [authService, client.enabled]);

  const sendMagicLink = useCallback(async (email: string, redirectTo?: string) => {
    if (!client.enabled) throw new Error("Supabase 환경 설정이 없어 로컬 전용 모드입니다.");
    await authService.sendMagicLink(email, redirectTo ?? AUTH_REDIRECT_URL);
  }, [authService, client.enabled]);

  const acceptAuthRedirect = useCallback(async (url: string) => {
    const session = authService.acceptRedirectUrl(url);
    const complete = { ...session, userId: session.userId ?? jwtSubject(session.accessToken) };
    authService.acceptSession(complete);
    await persistSession(complete);
    setAuth({ enabled: true, status: "authenticated", userId: complete.userId });
    setCloudSync((current) => ({ ...current, status: "idle", error: undefined }));
  }, [authService]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenForAuthDeepLinks(async (url) => {
      if (!disposed) await acceptAuthRedirect(url.toString());
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    }).catch((cause) => setAuth((current) => ({ ...current, error: message(cause) })));
    return () => { disposed = true; unlisten?.(); };
  }, [acceptAuthRedirect]);

  const signOut = useCallback(() => {
    authService.signOutLocally();
    window.localStorage.removeItem(SESSION_KEY);
    void removeProviderSecret("supabase").catch(() => undefined);
    setAuth({ enabled: client.enabled, status: client.enabled ? "signed_out" : "local" });
    setRemoteEvents([]);
    setDevices([currentDevice()]);
    setCloudSync({ status: client.enabled ? "signed_out" : "disabled", uploaded: 0, pending: 0 });
  }, [authService, client.enabled]);

  const syncNow = useCallback(async () => {
    await local.refresh();
    if (!client.enabled) {
      setCloudSync({ status: "disabled", uploaded: 0, pending: 0 });
      return;
    }
    if (!client.currentSession) {
      setCloudSync((current) => ({ ...current, status: "signed_out" }));
      return;
    }
    if (client.currentSession.expiresAt && client.currentSession.expiresAt <= Math.floor(Date.now() / 1000) + 30) {
      const refreshToken = client.currentSession.refreshToken ?? (await loadStoredSession())?.refreshToken;
      if (!refreshToken) {
        signOut();
        setAuth({ enabled: true, status: "signed_out", error: "로그인 세션이 만료되었습니다." });
        return;
      }
      try {
        const refreshed = await authService.refresh(refreshToken);
        await persistSession(refreshed);
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
        appVersion: "0.2.0",
        lastSeenAt: new Date().toISOString(),
      });
      if (deviceResult.error) throw new Error(deviceResult.error);
      const result = await syncService.upsertUsageEvents(outgoing);
      if (result.error) throw new Error(result.error);
      const [downloaded, accountDevices] = await Promise.all([syncService.listUsageEvents(), syncService.listDevices()]);
      setRemoteEvents(downloaded.flatMap(toLocalUsageEvent));
      const mergedTitles = mergeSessionTitles(sessionTitles, downloaded);
      setSessionTitles(mergedTitles);
      window.localStorage.setItem(TITLES_KEY, JSON.stringify(mergedTitles));
      setDevices(accountDevices.length ? accountDevices : [currentDevice()]);
      setCloudSync({ status: "idle", uploaded: result.uploaded, pending: 0, lastSyncedAt: new Date() });
    } catch (cause) {
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      setCloudSync((current) => ({ ...current, status: offline ? "offline" : "error", pending: outgoing.length, error: message(cause) }));
    } finally {
      syncingRef.current = false;
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

  const configureSupabase = useCallback((url: string, anonKey: string) => {
    const normalizedUrl = url.trim().replace(/\/+$/, "");
    const normalizedKey = anonKey.trim();
    if (!/^https?:\/\//i.test(normalizedUrl) || !normalizedKey) throw new Error("올바른 Supabase URL과 anon key가 필요합니다.");
    const config = { url: normalizedUrl, anonKey: normalizedKey };
    window.localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    setRuntimeConfig(config);
    setAuth({ enabled: true, status: "signed_out" });
    setCloudSync({ status: "signed_out", uploaded: 0, pending: 0 });
  }, []);

  const clearSupabaseConfig = useCallback(() => {
    window.localStorage.removeItem(CONFIG_KEY);
    window.localStorage.removeItem(SESSION_KEY);
    void removeProviderSecret("supabase").catch(() => undefined);
    setRuntimeConfig(null);
    setRemoteEvents([]);
    setDevices([currentDevice()]);
    setAuth({ enabled: false, status: "local" });
    setCloudSync({ status: "disabled", uploaded: 0, pending: 0 });
  }, []);

  const events = useMemo(() => {
    const currentProviderEvents = providerEvents.flatMap(toLocalUsageEvent);
    const cloudEvents = [...remoteEvents, ...currentProviderEvents];
    return mergeUsageWithProviderAuthority(local.events, cloudEvents);
  }, [local.events, providerEvents, remoteEvents]);

  return {
    ...local,
    events,
    combinedEvents: events,
    auth,
    cloudSync,
    credentials,
    providerUsage,
    devices,
    sessionTitles,
    sendMagicLink,
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
    appVersion: "0.2.0",
    lastSeenAt: new Date().toISOString(),
  };
}
function defaultQuery(): UsageQuery {
  const endTime = new Date();
  const startTime = new Date(endTime);
  startTime.setDate(startTime.getDate() - 30);
  return { startTime, endTime };
}
async function persistSession(session: SupabaseSession): Promise<void> {
  await storeProviderSecret("supabase", JSON.stringify(session));
  window.localStorage.removeItem(SESSION_KEY);
}
async function loadStoredSession(): Promise<SupabaseSession | null> {
  const secure = await loadProviderSecret("supabase").catch(() => undefined);
  if (secure) {
    try {
      const parsed = JSON.parse(secure) as SupabaseSession;
      if (parsed.accessToken) return parsed;
    } catch {
      const legacy = readJson<SupabaseSession | null>(SESSION_KEY, null);
      if (legacy?.accessToken) return { ...legacy, refreshToken: secure };
    }
  }
  return readJson<SupabaseSession | null>(SESSION_KEY, null);
}
function readJson<T>(key: string, fallback: T): T {
  try { return JSON.parse(window.localStorage.getItem(key) ?? "") as T; } catch { return fallback; }
}
function jwtSubject(token: string): string | undefined {
  try { return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sub; } catch { return undefined; }
}
function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
function deduplicateSyncEvents(events: SyncUsageEvent[]): SyncUsageEvent[] { return [...new Map(events.map((event) => [event.eventId, event])).values()]; }
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
