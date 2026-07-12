// 로컬 수집, 계정 동기화, 공급사 사용량 조회를 하나의 앱 런타임으로 연결하는 훅
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UsageEvent as LocalUsageEvent } from "../core";
import { stableId } from "../core/parse-utils";
import { AUTH_PKCE_VERIFIER_KEY, AUTH_REDIRECT_URL, AUTH_STATE_KEY, authRedirectCode, authRedirectWithState, createPkcePair, listenForAuthDeepLinks, verifyAuthRedirectState } from "../platform/deep-link";
import { openExternalBrowser } from "../platform/external-browser";
import {
  fetchStoredProviderUsage,
  ACCOUNT_PROVIDER_DEVICE_ID,
  buildUsageViews,
  loadOwnedProviderSecret,
  loadProviderSecret,
  mergeSessionTitles,
  providerRecordsToUsageEvents,
  parseProviderCredentials,
  removeOwnedProviderSecret,
  removeOwnedProviderSecretIfMarker,
  removeProviderSecret,
  removeProviderSecretIfMarker,
  storeOwnedProviderSecret,
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
  type DeviceInventory,
  type DeviceInventoryItem,
  type DeviceInventorySnapshot,
  type UsageQuery,
  createDeviceInventorySnapshot,
  isSupabasePublicKey,
  readSupabaseConfig,
} from "../services";
import {
  applyDeviceInventoryItems as applyNativeDeviceInventoryItems,
  collectDeviceInventory,
  type DeviceInventoryApplyResult,
} from "../platform/device-inventory";
import { getOrCreateDeviceId, useLocalUsage } from "./useLocalUsage";

const SESSION_KEY = "token-deck-supabase-session";
const TITLES_KEY = "token-deck-session-titles";
const TITLES_BY_OWNER_KEY = "token-deck-session-titles-by-owner";
const LOCAL_OWNERSHIP_KEY = "token-deck-local-session-owners";
const CONFIG_KEY = "token-deck-supabase-config";
const SESSION_TOMBSTONES_KEY = "token-deck-supabase-session-tombstones";
const INVENTORY_SYNC_KEY = "token-deck-device-inventory-sync";
const FULL_RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1_000;

type AuthStatus = "local" | "signed_out" | "authenticated";
type CloudSyncStatus = "disabled" | "signed_out" | "idle" | "syncing" | "offline" | "error";
type InventorySyncStatus = "disabled" | "signed_out" | "idle" | "syncing" | "error";

interface CredentialStatus { configured: boolean; checking: boolean; error?: string }

export function useAppRuntime() {
  const local = useLocalUsage();
  const [runtimeConfig, setRuntimeConfig] = useState<SupabaseConfig | null>(() => {
    const saved = readJson<SupabaseConfig | null>(CONFIG_KEY, null);
    return resolveSupabaseConfig(saved);
  });
  const client = useMemo(() => new SupabaseRestClient(runtimeConfig), [runtimeConfig]);
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
  const [localInventory, setLocalInventory] = useState<DeviceInventory>();
  const [deviceInventories, setDeviceInventories] = useState<DeviceInventorySnapshot[]>([]);
  const [inventorySyncEnabled, setInventorySyncEnabledState] = useState(false);
  const [inventorySync, setInventorySync] = useState<{ status: InventorySyncStatus; loading: boolean; error?: string }>({
    status: "disabled",
    loading: true,
  });
  const [providerEvents, setProviderEvents] = useState<SyncUsageEvent[]>([]);
  const [sessionTitles, setSessionTitles] = useState<Record<string, string>>(() => readSessionTitles(undefined));
  const [localOwnership, setLocalOwnership] = useState<Record<string, string>>(() => readJson(LOCAL_OWNERSHIP_KEY, {}));
  const accountGenerationRef = useRef(0);
  const authAttemptGenerationRef = useRef(0);
  const accountOwnerRef = useRef<string | undefined>(undefined);
  const providerEventsOwnerRef = useRef<string | undefined>(undefined);
  const localInventoryRef = useRef<DeviceInventory | undefined>(undefined);
  const inventorySyncEnabledRef = useRef(false);
  const inventorySyncRevisionRef = useRef(0);
  const inventorySyncCompletedRevisionRef = useRef(-1);
  const inventorySyncErrorRef = useRef<string | undefined>(undefined);
  const serializeSyncRef = useRef(createSerialTaskRunner());
  const syncCacheRef = useRef(createUsageSyncCache());
  const credentialOwner = providerCredentialOwner(auth.status, auth.userId, client.config, getOrCreateDeviceId());
  const credentialOwnerRef = useRef<string | undefined>(credentialOwner);
  credentialOwnerRef.current = credentialOwner;

  const clearAccountProviderState = useCallback(() => {
    providerEventsOwnerRef.current = undefined;
    setProviderEvents([]);
    setProviderUsage([]);
    setCredentials(emptyCredentialStatus());
    syncCacheRef.current = createUsageSyncCache();
  }, []);

  const clearAccountInventoryState = useCallback(() => {
    setDeviceInventories([]);
    inventorySyncRevisionRef.current += 1;
    inventorySyncCompletedRevisionRef.current = -1;
    inventorySyncErrorRef.current = undefined;
    inventorySyncEnabledRef.current = false;
    setInventorySyncEnabledState(false);
    setInventorySync({ status: client.enabled ? "signed_out" : "disabled", loading: false });
  }, [client.enabled]);

  const refreshDeviceInventory = useCallback(async (): Promise<DeviceInventory | undefined> => {
    inventorySyncErrorRef.current = undefined;
    setInventorySync((current) => ({ ...current, loading: true, error: undefined }));
    try {
      const inventory = await collectDeviceInventory();
      localInventoryRef.current = inventory;
      setLocalInventory(inventory);
      setInventorySync((current) => ({ ...current, loading: false }));
      return inventory;
    } catch (cause) {
      const error = message(cause);
      inventorySyncErrorRef.current = error;
      setInventorySync((current) => ({ ...current, status: "error", loading: false, error }));
      throw cause;
    }
  }, []);

  useEffect(() => { void refreshDeviceInventory().catch(() => undefined); }, [refreshDeviceInventory]);

  const activateSession = useCallback(async (
    session: SupabaseSession,
    generation: number,
    scope: string | undefined,
    resetProviderState = false,
  ) => {
    const complete = { ...session, userId: session.userId ?? jwtSubject(session.accessToken) };
    return commitSession(complete, generation, scope, {
      currentGeneration: () => accountGenerationRef.current,
      currentScope: () => sessionScope(client.config),
      persist: persistSession,
      discard: removePersistedSession,
      accept: (accepted) => {
        const nextOwner = accountOwner(scope, accepted);
        if (resetProviderState || accountOwnerRef.current !== nextOwner) {
          accountGenerationRef.current += 1;
          clearAccountProviderState();
          setRemoteEvents([]);
          setRemoteAccountEvents([]);
          setDevices([currentDevice()]);
          setSessionTitles(readSessionTitles(nextOwner));
          clearAccountInventoryState();
          const enabled = readInventorySyncPreference(nextOwner);
          inventorySyncEnabledRef.current = enabled;
          setInventorySyncEnabledState(enabled);
          setInventorySync({ status: enabled ? "idle" : "disabled", loading: false });
        }
        clearSessionTombstone(scope);
        accountOwnerRef.current = nextOwner;
        credentialOwnerRef.current = nextOwner;
        authService.acceptSession(accepted);
        setAuth({ enabled: true, status: "authenticated", userId: accepted.userId });
        setCloudSync((current) => ({ ...current, status: "idle", error: undefined }));
      },
    });
  }, [authService, clearAccountInventoryState, clearAccountProviderState, client.config]);

  const refreshCredentialStatus = useCallback(async () => {
    const providers: CredentialProvider[] = ["openai", "anthropic", "google"];
    const generation = accountGenerationRef.current;
    if (!credentialOwner) {
      setCredentials(emptyCredentialStatus());
      return;
    }
    setCredentials((current) => Object.fromEntries(providers.map((provider) => [provider, { ...current[provider], checking: true }])) as Record<CredentialProvider, CredentialStatus>);
    const results = await Promise.all(providers.map(async (provider) => {
      try {
        return [provider, { configured: Boolean(await loadOwnedProviderSecret(provider, credentialOwner)), checking: false }] as const;
      } catch (cause) {
        return [provider, { configured: false, checking: false, error: message(cause) }] as const;
      }
    }));
    if (generation !== accountGenerationRef.current || credentialOwnerRef.current !== credentialOwner) return;
    setCredentials(Object.fromEntries(results) as Record<CredentialProvider, CredentialStatus>);
  }, [credentialOwner]);

  useEffect(() => { void refreshCredentialStatus(); }, [refreshCredentialStatus]);

  useEffect(() => {
    if (!client.enabled) return;
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
        await serializeSyncRef.current(() => activateSession(session, generation, sessionScope(client.config), true));
      } catch (cause) {
        if (cancelled || generation !== accountGenerationRef.current) return;
        window.localStorage.removeItem(SESSION_KEY);
        setAuth({ enabled: true, status: "signed_out", error: message(cause) });
      }
    };
    void restore();
    return () => { cancelled = true; };
  }, [activateSession, authService, client]);

  const sendMagicLink = useCallback(async (email: string, redirectTo?: string) => {
    if (!client.enabled) throw new Error("Supabase 환경 설정이 없어 로컬 전용 모드입니다.");
    authAttemptGenerationRef.current += 1;
    const state = crypto.randomUUID();
    const { verifier, challenge } = await createPkcePair();
    window.localStorage.setItem(AUTH_STATE_KEY, state);
    window.localStorage.setItem(AUTH_PKCE_VERIFIER_KEY, verifier);
    try {
      await authService.sendMagicLink(email, authRedirectWithState(state, redirectTo ?? AUTH_REDIRECT_URL), challenge);
    } catch (cause) {
      if (window.localStorage.getItem(AUTH_STATE_KEY) === state) window.localStorage.removeItem(AUTH_STATE_KEY);
      if (window.localStorage.getItem(AUTH_PKCE_VERIFIER_KEY) === verifier) window.localStorage.removeItem(AUTH_PKCE_VERIFIER_KEY);
      throw cause;
    }
  }, [authService, client.enabled]);

  const signInWithGoogle = useCallback(async () => {
    if (!client.enabled) throw new Error("Supabase 환경 설정이 없어 로컬 전용 모드입니다.");
    authAttemptGenerationRef.current += 1;
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
    const attemptGeneration = authAttemptGenerationRef.current;
    const scope = sessionScope(client.config);
    verifyAuthRedirectState(url, window.localStorage.getItem(AUTH_STATE_KEY));
    const codeVerifier = window.localStorage.getItem(AUTH_PKCE_VERIFIER_KEY) ?? "";
    window.localStorage.removeItem(AUTH_STATE_KEY);
    window.localStorage.removeItem(AUTH_PKCE_VERIFIER_KEY);
    const code = requireOneTimeAuthCode(url);
    const session = await authService.exchangeCodeForSession(code, codeVerifier);
    await serializeSyncRef.current(() => (
      attemptGeneration === authAttemptGenerationRef.current
        ? activateSession(session, generation, scope, true)
        : Promise.resolve(false)
    ));
  }, [activateSession, authService, client.config]);

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
    const scope = sessionScope(client.config);
    const localErrors: string[] = [];
    try { markSessionTombstone(scope); } catch (cause) { localErrors.push(`로그아웃 표시 저장 실패: ${message(cause)}`); }
    const remoteLogout = authService.signOutRemotely();
    const generation = ++accountGenerationRef.current;
    authService.signOutLocally();
    accountOwnerRef.current = undefined;
    credentialOwnerRef.current = localProviderCredentialOwner(getOrCreateDeviceId());
    clearAccountProviderState();
    clearAccountInventoryState();
    window.localStorage.removeItem(SESSION_KEY);
    window.localStorage.removeItem(AUTH_STATE_KEY);
    window.localStorage.removeItem(AUTH_PKCE_VERIFIER_KEY);
    setAuth({ enabled: client.enabled, status: client.enabled ? "signed_out" : "local" });
    setRemoteEvents([]);
    setRemoteAccountEvents([]);
    setDevices([currentDevice()]);
    setSessionTitles(readSessionTitles(undefined));
    setCloudSync({ status: client.enabled ? "signed_out" : "disabled", uploaded: 0, pending: 0 });
    const outcomes = await Promise.allSettled([remoteLogout, removeProviderSecret("supabase")]);
    const errors = [
      ...localErrors,
      ...outcomes.flatMap((outcome, index) => outcome.status === "rejected"
        ? [`${index === 0 ? "원격 로그아웃" : "저장된 세션 삭제"} 실패: ${message(outcome.reason)}`]
        : []),
    ];
    if (errors.length && generation === accountGenerationRef.current) {
      setAuth({ enabled: client.enabled, status: client.enabled ? "signed_out" : "local", error: errors.join(" ") });
    }
  }, [authService, clearAccountInventoryState, clearAccountProviderState, client.config, client.enabled]);

  const syncNow = useCallback(() => serializeSyncRef.current(async () => {
    const generation = accountGenerationRef.current;
    await local.refresh();
    if (generation !== accountGenerationRef.current) return;
    if (!client.enabled) {
      setCloudSync({ status: "disabled", uploaded: 0, pending: 0 });
      return;
    }
    if (auth.status !== "authenticated" || !client.currentSession) {
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
        if (!await activateSession(refreshed, generation, refreshScope)) return;
      } catch (cause) {
        setAuth((current) => ({ ...current, error: message(cause) }));
        return;
      }
    }
    if (generation !== accountGenerationRef.current || auth.status !== "authenticated" || !client.currentSession) return;
    const activeOwner = accountOwner(sessionScope(client.config), client.currentSession);
    if (!activeOwner) {
      setCloudSync((current) => ({ ...current, status: "error", error: "동기화할 계정 소유자를 확인할 수 없습니다." }));
      return;
    }
    const ownedProviderEvents = providerEventsForOwner(providerEvents, providerEventsOwnerRef.current, activeOwner);
    const localClaim = claimAccountLocalEvents(localOwnership, local.events, activeOwner);
    if (localClaim.ownership !== localOwnership) {
      setLocalOwnership(localClaim.ownership);
      window.localStorage.setItem(LOCAL_OWNERSHIP_KEY, JSON.stringify(localClaim.ownership));
    }
    const titled = localEventsToTitledSyncEvents(localClaim.events, sessionTitles);
    const outgoing = deduplicateSyncEvents([...titled, ...ownedProviderEvents]);
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setCloudSync((current) => ({ ...current, status: "offline", pending: outgoing.length, error: "네트워크가 복구되면 자동으로 다시 시도합니다." }));
      return;
    }
    if (syncCacheRef.current.owner !== activeOwner) syncCacheRef.current = createUsageSyncCache(activeOwner);
    const cache = syncCacheRef.current;
    const cycleStartedAt = Date.now();
    const fullReconcile = shouldFullyReconcile(cache, cycleStartedAt);
    const currentPhysicalDeviceId = getOrCreateDeviceId();
    setCloudSync((current) => ({ ...current, status: "syncing", pending: outgoing.length, error: undefined }));
    try {
      const downloaded = await syncService.listUsageEvents(
        fullReconcile ? undefined : cache.cursor,
        fullReconcile ? undefined : currentPhysicalDeviceId,
      );
      if (generation !== accountGenerationRef.current || activeOwner !== accountOwnerRef.current) return;
      reconcileDownloadedUsage(cache, downloaded, fullReconcile, cycleStartedAt);
      const changed = selectChangedUsageEvents(cache, outgoing);
      setCloudSync((current) => ({ ...current, pending: changed.length }));
      const deviceResult = await syncService.registerDevice({
        id: currentPhysicalDeviceId,
        name: typeof navigator !== "undefined" ? navigator.platform || "Windows 기기" : "Windows 기기",
        platform: "windows",
        appVersion: "0.4.0",
        lastSeenAt: new Date().toISOString(),
      });
      if (deviceResult.error) throw new Error(deviceResult.error);
      if (changed.some((event) => event.source === "provider_api" || event.source === "cloud_billing")) {
        const accountDeviceResult = await syncService.registerDevice({
          id: ACCOUNT_PROVIDER_DEVICE_ID,
          name: "계정 API 집계",
          platform: "account",
          appVersion: "0.4.0",
          lastSeenAt: new Date().toISOString(),
        });
        if (accountDeviceResult.error) throw new Error(accountDeviceResult.error);
      }
      const result = await syncService.upsertUsageEvents(changed);
      if (result.error) throw new Error(result.error);
      recordUploadedUsage(cache, changed);
      const accountDevices = await syncService.listDevices();
      if (generation !== accountGenerationRef.current || activeOwner !== accountOwnerRef.current) return;
      const combinedRemote = [...cache.remoteEvents.values()];
      setRemoteEvents(combinedRemote.flatMap(toLocalUsageEvent));
      setRemoteAccountEvents(combinedRemote.filter((event) => event.source === "provider_api" || event.source === "cloud_billing"));
      const mergedTitles = mergeSessionTitles(sessionTitles, combinedRemote);
      setSessionTitles(mergedTitles);
      writeSessionTitles(activeOwner, mergedTitles);
      const physicalDevices = accountDevices.filter((device) => device.id !== ACCOUNT_PROVIDER_DEVICE_ID);
      setDevices(physicalDevices.length ? physicalDevices : [currentDevice()]);
      setCloudSync({ status: "idle", uploaded: result.uploaded, pending: 0, lastSyncedAt: new Date() });
      if (inventorySyncEnabledRef.current) {
        const inventoryRevision = inventorySyncRevisionRef.current;
        inventorySyncCompletedRevisionRef.current = -1;
        inventorySyncErrorRef.current = undefined;
        setInventorySync((current) => ({ ...current, status: "syncing", loading: true, error: undefined }));
        inventoryUpdate: try {
          const cachedInventory = localInventoryRef.current;
          const inventory = !cachedInventory || Date.now() - cachedInventory.capturedAt > 5 * 60 * 1_000
            ? await refreshDeviceInventory()
            : cachedInventory;
          if (generation !== accountGenerationRef.current || activeOwner !== accountOwnerRef.current) return;
          if (inventoryRevision !== inventorySyncRevisionRef.current || !inventorySyncEnabledRef.current) {
            setInventorySync({ status: "disabled", loading: false });
            break inventoryUpdate;
          }
          if (!inventory) throw new Error("현재 기기의 설정 목록을 수집하지 못했습니다.");
          const inventoryResult = await syncService.upsertDeviceInventorySnapshot(
            createDeviceInventorySnapshot(currentPhysicalDeviceId, inventory),
          );
          if (inventoryResult.error) throw new Error(inventoryResult.error);
          if (generation !== accountGenerationRef.current || activeOwner !== accountOwnerRef.current) return;
          if (inventoryRevision !== inventorySyncRevisionRef.current || !inventorySyncEnabledRef.current) {
            setInventorySync({ status: "disabled", loading: false });
            break inventoryUpdate;
          }
          const snapshots = await syncService.listDeviceInventorySnapshots();
          if (generation !== accountGenerationRef.current || activeOwner !== accountOwnerRef.current) return;
          if (inventoryRevision !== inventorySyncRevisionRef.current || !inventorySyncEnabledRef.current) {
            setInventorySync({ status: "disabled", loading: false });
            break inventoryUpdate;
          }
          setDeviceInventories(snapshots);
          inventorySyncCompletedRevisionRef.current = inventoryRevision;
          setInventorySync({ status: "idle", loading: false });
        } catch (cause) {
          if (generation === accountGenerationRef.current && activeOwner === accountOwnerRef.current) {
            const error = inventorySyncErrorMessage(cause);
            inventorySyncErrorRef.current = error;
            setInventorySync({ status: "error", loading: false, error });
          }
        }
      } else {
        setInventorySync({ status: "disabled", loading: false });
      }
    } catch (cause) {
      if (generation !== accountGenerationRef.current) return;
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      setCloudSync((current) => ({ ...current, status: offline ? "offline" : "error", pending: outgoing.length, error: message(cause) }));
      if (inventorySyncEnabledRef.current && activeOwner === accountOwnerRef.current) {
        const error = offline ? "오프라인 상태라 기기 설정 목록을 동기화하지 못했습니다." : "기존 계정 동기화 오류로 기기 설정 목록 갱신을 완료하지 못했습니다.";
        inventorySyncErrorRef.current = error;
        setInventorySync({ status: "error", loading: false, error });
      }
    }
  }), [activateSession, auth.status, authService, client, local.events, local.refresh, localOwnership, providerEvents, refreshDeviceInventory, sessionTitles, signOut, syncService]);

  const syncNowRef = useRef(syncNow);
  syncNowRef.current = syncNow;
  useEffect(() => {
    if (auth.status !== "authenticated") return;
    const retry = () => void syncNowRef.current();
    window.addEventListener("online", retry);
    const timer = window.setInterval(retry, 60_000);
    void syncNowRef.current();
    return () => { window.removeEventListener("online", retry); window.clearInterval(timer); };
  }, [auth.status]);

  const refreshAndSyncDeviceInventory = useCallback(async (): Promise<void> => {
    if (auth.status !== "authenticated" || !accountOwnerRef.current) {
      throw new Error("기기 설정 목록을 동기화하려면 먼저 계정에 로그인해 주세요.");
    }
    if (!inventorySyncEnabledRef.current) throw new Error("이 기기의 도구 목록 자동 갱신을 먼저 켜 주세요.");
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      const error = "오프라인 상태라 기기 설정 목록을 동기화하지 못했습니다.";
      inventorySyncErrorRef.current = error;
      setInventorySync({ status: "error", loading: false, error });
      throw new Error(error);
    }
    const generation = accountGenerationRef.current;
    const owner = accountOwnerRef.current;
    const revision = inventorySyncRevisionRef.current;
    inventorySyncCompletedRevisionRef.current = -1;
    await refreshDeviceInventory();
    await syncNowRef.current();
    if (generation !== accountGenerationRef.current || owner !== accountOwnerRef.current) {
      throw new Error("로그인 계정이 변경되어 기기 설정 목록 동기화를 중단했습니다.");
    }
    if (inventorySyncErrorRef.current) throw new Error(inventorySyncErrorRef.current);
    if (inventorySyncCompletedRevisionRef.current !== revision) {
      throw new Error("기기 설정 목록 동기화를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    }
  }, [auth.status, refreshDeviceInventory]);

  const setInventorySyncEnabled = useCallback(async (enabled: boolean) => {
    if (auth.status !== "authenticated" || !accountOwnerRef.current) {
      throw new Error("기기 설정 목록을 동기화하려면 먼저 계정에 로그인해 주세요.");
    }
    writeInventorySyncPreference(accountOwnerRef.current, enabled);
    inventorySyncRevisionRef.current += 1;
    inventorySyncEnabledRef.current = enabled;
    setInventorySyncEnabledState(enabled);
    if (!enabled) {
      inventorySyncErrorRef.current = undefined;
      setInventorySync({ status: "disabled", loading: false });
      return;
    }
    setInventorySync({ status: "syncing", loading: true });
    await refreshAndSyncDeviceInventory();
  }, [auth.status, refreshAndSyncDeviceInventory]);

  const applyDeviceInventoryItems = useCallback(async (
    sourceDeviceId: string,
    requestedItems: DeviceInventoryItem[],
  ): Promise<DeviceInventoryApplyResult[]> => {
    const currentDeviceId = getOrCreateDeviceId();
    const selected = selectRemoteInventoryItems(
      deviceInventories,
      currentDeviceId,
      sourceDeviceId,
      requestedItems,
      localInventoryRef.current?.items ?? [],
    );
    if (!selected.length) throw new Error("현재 기기로 가져올 수 있는 원격 설정 항목이 없습니다.");
    const generation = accountGenerationRef.current;
    const owner = accountOwnerRef.current;
    const results = await applyNativeDeviceInventoryItems(selected);
    if (generation !== accountGenerationRef.current || owner !== accountOwnerRef.current) {
      throw new Error("로그인 계정이 변경되어 설정 목록 갱신을 중단했습니다.");
    }
    await refreshDeviceInventory();
    if (inventorySyncEnabledRef.current) await syncNowRef.current();
    return results;
  }, [deviceInventories, refreshDeviceInventory]);

  const saveProviderCredential = useCallback((provider: CredentialProvider, value: ProviderCredentials | Record<string, string>) => serializeSyncRef.current(async () => {
    if (!credentialOwner || credentialOwnerRef.current !== credentialOwner) throw new Error("로그인 계정이 변경되었습니다. 자격 증명을 다시 저장해 주세요.");
    const generation = accountGenerationRef.current;
    parseProviderCredentials(provider, JSON.stringify(value));
    const marker = await storeOwnedProviderSecret(provider, credentialOwner, JSON.stringify(value));
    if (generation !== accountGenerationRef.current || credentialOwnerRef.current !== credentialOwner) {
      await removeOwnedProviderSecretIfMarker(provider, credentialOwner, marker).catch(() => undefined);
      throw new Error("로그인 계정이 변경되어 자격 증명 저장을 취소했습니다.");
    }
    await refreshCredentialStatus();
  }), [credentialOwner, refreshCredentialStatus]);

  const removeProviderCredential = useCallback((provider: CredentialProvider) => serializeSyncRef.current(async () => {
    if (!credentialOwner || credentialOwnerRef.current !== credentialOwner) throw new Error("로그인 계정이 변경되었습니다. 자격 증명 상태를 다시 확인해 주세요.");
    const generation = accountGenerationRef.current;
    await removeOwnedProviderSecret(provider, credentialOwner);
    if (generation !== accountGenerationRef.current || credentialOwnerRef.current !== credentialOwner) return;
    setProviderUsage((current) => current.filter((item) => item.provider !== provider));
    setProviderEvents((current) => current.filter((item) => item.provider !== provider));
    await refreshCredentialStatus();
  }), [credentialOwner, refreshCredentialStatus]);

  const refreshProviderUsage = useCallback(async (provider: CredentialProvider, query: UsageQuery = defaultQuery()) => {
    const generation = accountGenerationRef.current;
    const owner = auth.status === "authenticated" ? accountOwner(sessionScope(client.config), client.currentSession) : undefined;
    if (!credentialOwner || credentialOwnerRef.current !== credentialOwner) throw new Error("로그인 계정이 변경되었습니다. 자격 증명 상태를 다시 확인해 주세요.");
    const records = await fetchStoredProviderUsage(provider, credentialOwner, query);
    if (generation !== accountGenerationRef.current
      || credentialOwnerRef.current !== credentialOwner
      || owner !== (auth.status === "authenticated" ? accountOwnerRef.current : undefined)) return [];
    const converted = providerRecordsToUsageEvents(records, getOrCreateDeviceId());
    providerEventsOwnerRef.current = owner;
    setProviderUsage((current) => [...current.filter((item) => item.provider !== provider), ...records]);
    setProviderEvents((current) => deduplicateSyncEvents([...current.filter((item) => item.provider !== provider), ...converted]));
    return converted;
  }, [auth.status, client, credentialOwner]);

  const refreshProviderUsageForUi = useCallback(async (provider: CredentialProvider, query?: UsageQuery): Promise<void> => {
    await refreshProviderUsage(provider, query);
  }, [refreshProviderUsage]);

  const updateSessionTitle = useCallback(async (sessionId: string, title: string) => {
    const next = { ...sessionTitles };
    const normalized = title.trim();
    if (normalized) next[sessionId] = normalized;
    else delete next[sessionId];
    setSessionTitles(next);
    writeSessionTitles(auth.status === "authenticated" ? accountOwnerRef.current : undefined, next);
  }, [auth.status, sessionTitles]);

  const configureSupabase = useCallback(async (url: string, publishableKey: string) => {
    const normalizedUrl = url.trim().replace(/\/+$/, "");
    const normalizedKey = publishableKey.trim();
    if (!isSecureSupabaseUrl(normalizedUrl) || !isSupabasePublicKey(normalizedKey)) throw new Error("HTTPS Supabase URL과 publishable key가 필요합니다. secret 또는 service_role key는 저장할 수 없습니다.");
    const config = { url: normalizedUrl, anonKey: normalizedKey };
    const cleanupErrors: string[] = [];
    try { markSessionTombstone(sessionScope(client.config)); } catch (cause) { cleanupErrors.push(`로그아웃 표시 저장 실패: ${message(cause)}`); }
    const generation = ++accountGenerationRef.current;
    authService.signOutLocally();
    accountOwnerRef.current = undefined;
    credentialOwnerRef.current = localProviderCredentialOwner(getOrCreateDeviceId());
    clearAccountProviderState();
    clearAccountInventoryState();
    window.localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    window.localStorage.removeItem(SESSION_KEY);
    window.localStorage.removeItem(AUTH_STATE_KEY);
    window.localStorage.removeItem(AUTH_PKCE_VERIFIER_KEY);
    setRuntimeConfig(config);
    setRemoteEvents([]);
    setRemoteAccountEvents([]);
    setDevices([currentDevice()]);
    setSessionTitles(readSessionTitles(undefined));
    setAuth({ enabled: true, status: "signed_out", error: cleanupErrors.length ? cleanupErrors.join(" ") : undefined });
    setCloudSync({ status: "signed_out", uploaded: 0, pending: 0 });
    await removeProviderSecret("supabase").catch((cause) => cleanupErrors.push(`저장된 세션 삭제 실패: ${message(cause)}`));
    if (cleanupErrors.length && generation === accountGenerationRef.current) {
      setAuth({ enabled: true, status: "signed_out", error: cleanupErrors.join(" ") });
    }
  }, [authService, clearAccountInventoryState, clearAccountProviderState, client.config]);

  const clearSupabaseConfig = useCallback(async () => {
    const cleanupErrors: string[] = [];
    try { markSessionTombstone(sessionScope(client.config)); } catch (cause) { cleanupErrors.push(`로그아웃 표시 저장 실패: ${message(cause)}`); }
    const generation = ++accountGenerationRef.current;
    authService.signOutLocally();
    accountOwnerRef.current = undefined;
    credentialOwnerRef.current = localProviderCredentialOwner(getOrCreateDeviceId());
    clearAccountProviderState();
    clearAccountInventoryState();
    window.localStorage.removeItem(CONFIG_KEY);
    window.localStorage.removeItem(SESSION_KEY);
    window.localStorage.removeItem(AUTH_STATE_KEY);
    window.localStorage.removeItem(AUTH_PKCE_VERIFIER_KEY);
    const defaultConfig = readSupabaseConfig();
    setRuntimeConfig(defaultConfig);
    setRemoteEvents([]);
    setRemoteAccountEvents([]);
    setDevices([currentDevice()]);
    setSessionTitles(readSessionTitles(undefined));
    setAuth({ enabled: Boolean(defaultConfig), status: defaultConfig ? "signed_out" : "local", error: cleanupErrors.length ? cleanupErrors.join(" ") : undefined });
    setCloudSync({ status: defaultConfig ? "signed_out" : "disabled", uploaded: 0, pending: 0 });
    await removeProviderSecret("supabase").catch((cause) => cleanupErrors.push(`저장된 세션 삭제 실패: ${message(cause)}`));
    if (cleanupErrors.length && generation === accountGenerationRef.current) {
      setAuth({ enabled: Boolean(defaultConfig), status: defaultConfig ? "signed_out" : "local", error: cleanupErrors.join(" ") });
    }
  }, [authService, clearAccountInventoryState, clearAccountProviderState, client.config]);

  const usageViews = useMemo(() => {
    const activeOwner = auth.status === "authenticated" ? accountOwnerRef.current : undefined;
    const visibleLocalEvents = activeOwner ? filterAccountLocalEvents(local.events, localOwnership, activeOwner) : local.events;
    const currentProviderEvents = providerEventsForOwner(providerEvents, providerEventsOwnerRef.current, activeOwner).flatMap(toLocalUsageEvent);
    const cloudEvents = [...remoteEvents, ...currentProviderEvents];
    return buildUsageViews(visibleLocalEvents, cloudEvents);
  }, [auth.status, local.events, localOwnership, providerEvents, remoteEvents]);
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
    localInventory,
    deviceInventories,
    inventorySyncEnabled,
    inventorySync,
    sessionTitles,
    sendMagicLink,
    signInWithGoogle,
    acceptAuthRedirect,
    signOut,
    syncNow,
    refreshDeviceInventory,
    refreshAndSyncDeviceInventory,
    setInventorySyncEnabled,
    applyDeviceInventoryItems,
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
    appVersion: "0.4.0",
    lastSeenAt: new Date().toISOString(),
  };
}
function defaultQuery(): UsageQuery {
  const endTime = new Date();
  const startTime = new Date(endTime);
  startTime.setDate(startTime.getDate() - 30);
  return { startTime, endTime };
}

interface SessionCommitControls {
  currentGeneration: () => number;
  currentScope: () => string | undefined;
  persist: (session: SupabaseSession, scope?: string) => Promise<string>;
  discard: (marker: string) => Promise<void>;
  accept: (session: SupabaseSession) => void;
}

export async function commitSession(
  session: SupabaseSession,
  generation: number,
  scope: string | undefined,
  controls: SessionCommitControls,
): Promise<boolean> {
  if (!scope || generation !== controls.currentGeneration() || scope !== controls.currentScope()) return false;
  const marker = await controls.persist(session, scope);
  if (generation !== controls.currentGeneration() || scope !== controls.currentScope()) {
    await controls.discard(marker);
    return false;
  }
  controls.accept(session);
  return true;
}

async function persistSession(session: SupabaseSession, scope?: string): Promise<string> {
  if (!scope) throw new Error("Supabase 세션을 저장할 서버 설정이 없습니다.");
  const marker = crypto.randomUUID();
  try {
    await storeProviderSecret("supabase", JSON.stringify({ scope, session, marker }));
  } catch (cause) {
    markSessionTombstone(scope);
    await removeProviderSecretIfMarker("supabase", marker).catch(() => undefined);
    throw cause;
  }
  window.localStorage.removeItem(SESSION_KEY);
  return marker;
}

async function removePersistedSession(marker: string): Promise<void> {
  await removeProviderSecretIfMarker("supabase", marker).catch(() => undefined);
}
export async function loadStoredSession(
  scope?: string,
  storage: Storage = window.localStorage,
  loadSecret: () => Promise<string | undefined> = () => loadProviderSecret("supabase"),
): Promise<SupabaseSession | null> {
  if (!scope) return null;
  if (hasSessionTombstone(scope, storage)) return null;
  const secure = await loadSecret().catch(() => undefined);
  if (secure) {
    try {
      const parsed = JSON.parse(secure) as { scope?: string; session?: SupabaseSession };
      if (parsed.scope === scope && parsed.session?.accessToken) return parsed.session;
      return null;
    } catch {
      const legacy = readJsonFromStorage<SupabaseSession | null>(storage, SESSION_KEY, null);
      if (legacy?.accessToken) return { ...legacy, refreshToken: secure };
    }
  }
  return readJsonFromStorage<SupabaseSession | null>(storage, SESSION_KEY, null);
}

export function markSessionTombstone(scope?: string, storage: Storage = window.localStorage): void {
  if (!scope) return;
  const tombstones = readJsonFromStorage<Record<string, number>>(storage, SESSION_TOMBSTONES_KEY, {});
  storage.setItem(SESSION_TOMBSTONES_KEY, JSON.stringify({ ...tombstones, [scope]: Date.now() }));
}

export function clearSessionTombstone(scope?: string, storage: Storage = window.localStorage): void {
  if (!scope) return;
  const tombstones = readJsonFromStorage<Record<string, number>>(storage, SESSION_TOMBSTONES_KEY, {});
  if (!(scope in tombstones)) return;
  delete tombstones[scope];
  if (Object.keys(tombstones).length) storage.setItem(SESSION_TOMBSTONES_KEY, JSON.stringify(tombstones));
  else storage.removeItem(SESSION_TOMBSTONES_KEY);
}

export function hasSessionTombstone(scope: string, storage: Storage = window.localStorage): boolean {
  return scope in readJsonFromStorage<Record<string, number>>(storage, SESSION_TOMBSTONES_KEY, {});
}

export function requireOneTimeAuthCode(url: string): string {
  const parsed = new URL(url);
  const code = authRedirectCode(url);
  if (parsed.hash || !code || parsed.searchParams.get("code") !== code) {
    throw new Error("보안을 위해 일회용 인증 코드 콜백만 허용합니다. 로그인을 다시 시작해 주세요.");
  }
  return code;
}

export function createSerialTaskRunner(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>) => {
    const run = tail.then(task, task);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

export interface UsageSyncCache {
  owner?: string;
  initialized: boolean;
  fingerprints: Map<string, string>;
  remoteEvents: Map<string, SyncUsageEvent>;
  cursor?: string;
  lastFullAt?: number;
}

export function createUsageSyncCache(owner?: string): UsageSyncCache {
  return { owner, initialized: false, fingerprints: new Map(), remoteEvents: new Map() };
}

export function shouldFullyReconcile(cache: UsageSyncCache, now = Date.now()): boolean {
  return !cache.initialized || !cache.lastFullAt || now - cache.lastFullAt >= FULL_RECONCILE_INTERVAL_MS;
}

export function reconcileDownloadedUsage(
  cache: UsageSyncCache,
  downloaded: SyncUsageEvent[],
  fullReconcile: boolean,
  now = Date.now(),
): void {
  if (fullReconcile) {
    cache.fingerprints.clear();
    cache.remoteEvents.clear();
    cache.cursor = undefined;
    cache.lastFullAt = now;
  }
  for (const event of downloaded) {
    cache.fingerprints.set(event.eventId, usageEventFingerprint(event));
    cache.remoteEvents.set(event.eventId, event);
    advanceUsageCursor(cache, event.createdAt);
  }
  cache.cursor ??= new Date(now - 5 * 60_000).toISOString();
  cache.initialized = true;
}

export function selectChangedUsageEvents(cache: UsageSyncCache, outgoing: SyncUsageEvent[]): SyncUsageEvent[] {
  return outgoing.filter((event) => cache.fingerprints.get(event.eventId) !== usageEventFingerprint(event));
}

export function recordUploadedUsage(cache: UsageSyncCache, uploaded: SyncUsageEvent[]): void {
  for (const event of uploaded) {
    cache.fingerprints.set(event.eventId, usageEventFingerprint(event));
    cache.remoteEvents.set(event.eventId, event);
  }
}

export function advanceUsageCursor(cache: UsageSyncCache, candidate?: string): void {
  if (!candidate) return;
  const candidateTime = Date.parse(candidate);
  const currentTime = cache.cursor ? Date.parse(cache.cursor) : Number.NEGATIVE_INFINITY;
  if (Number.isFinite(candidateTime) && candidateTime > currentTime) cache.cursor = candidate;
}

export function usageEventFingerprint(event: SyncUsageEvent): string {
  const metadata = Object.entries(event.metadata ?? {})
    .filter(([key]) => key !== "externalSessionId" && key !== "externalProjectId")
    .sort(([left], [right]) => left.localeCompare(right));
  const value = JSON.stringify([
    event.provider, event.source, event.deviceId, event.sessionId ?? "", event.projectId ?? "", event.model ?? "",
    event.occurredAt, event.inputTokens, event.cachedTokens, event.outputTokens, event.reasoningTokens, event.toolTokens,
    event.sessionTitle ?? "", metadata,
  ]);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

export function providerEventsForOwner(
  events: SyncUsageEvent[],
  eventsOwner: string | undefined,
  activeOwner: string | undefined,
): SyncUsageEvent[] {
  return activeOwner && eventsOwner === activeOwner ? events : [];
}

export function resolveSupabaseConfig(
  saved: SupabaseConfig | null,
  buildDefault: SupabaseConfig | null = readSupabaseConfig(),
): SupabaseConfig | null {
  return saved && isSecureSupabaseUrl(saved.url) && isSupabasePublicKey(saved.anonKey) ? saved : buildDefault;
}

function accountOwner(scope: string | undefined, session: SupabaseSession | null): string | undefined {
  const userId = session?.userId ?? (session?.accessToken ? jwtSubject(session.accessToken) : undefined);
  return scope && userId ? `${scope}\n${userId}` : undefined;
}

export function providerCredentialOwner(
  status: AuthStatus,
  userId: string | undefined,
  config: SupabaseConfig | null,
  deviceId: string,
): string | undefined {
  if (status === "authenticated") {
    const scope = sessionScope(config);
    return scope && userId ? `${scope}\n${userId}` : undefined;
  }
  return localProviderCredentialOwner(deviceId);
}

function localProviderCredentialOwner(deviceId: string): string | undefined {
  return deviceId ? `local\n${deviceId}` : undefined;
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
export function claimAccountLocalEvents(
  ownership: Record<string, string>,
  events: LocalUsageEvent[],
  owner: string,
): { events: LocalUsageEvent[]; ownership: Record<string, string> } {
  let next = ownership;
  const owned: LocalUsageEvent[] = [];
  for (const event of events) {
    const key = localUsageOwnershipKey(event);
    const currentOwner = next[key];
    if (!currentOwner) {
      if (next === ownership) next = { ...ownership };
      next[key] = owner;
      owned.push(event);
    } else if (currentOwner === owner) {
      owned.push(event);
    }
  }
  return { events: owned, ownership: next };
}

export function filterAccountLocalEvents(
  events: LocalUsageEvent[],
  ownership: Record<string, string>,
  owner: string,
): LocalUsageEvent[] {
  return events.filter((event) => ownership[localUsageOwnershipKey(event)] === owner);
}

export function localEventsToTitledSyncEvents(
  events: LocalUsageEvent[],
  sessionTitles: Record<string, string>,
): SyncUsageEvent[] {
  return events.map((event) => ({
    ...toSyncUsageEvents([event])[0],
    sessionTitle: event.sessionId ? sessionTitles[event.sessionId] : undefined,
  }));
}

export function selectRemoteInventoryItems(
  snapshots: DeviceInventorySnapshot[],
  currentDeviceId: string,
  sourceDeviceId: string,
  requestedItems: DeviceInventoryItem[],
  localItems: DeviceInventoryItem[] = [],
): DeviceInventoryItem[] {
  if (!sourceDeviceId || sourceDeviceId === currentDeviceId) return [];
  const source = snapshots.find((snapshot) => snapshot.deviceId === sourceDeviceId);
  if (!source) return [];
  const allowed = new Map<string, DeviceInventoryItem>();
  source.items
    .filter((item) => isSafeRemoteMarketplacePlugin(item) || canReactivateLocalGeminiItem(item, localItems))
    .forEach((item) => allowed.set(inventoryItemFingerprint(item), item));
  return requestedItems.flatMap((item) => {
    const canonical = allowed.get(inventoryItemFingerprint(item));
    return canonical ? [canonical] : [];
  }).filter((item, index, items) => items.findIndex((candidate) => inventoryItemFingerprint(candidate) === inventoryItemFingerprint(item)) === index);
}

function isSafeRemoteMarketplacePlugin(item: DeviceInventoryItem): boolean {
  if (item.provider === "gemini" || item.kind !== "plugin" || !item.installed || !item.enabled || !item.transferable) return false;
  if (item.hasSecrets || item.blockedReason || !item.marketplace || !["marketplace", "bundled"].includes(item.source)) return false;
  if (item.key.length > 128) return false;
  const parts = item.key.split("@");
  const validPart = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
  return parts.length === 2 && validPart(parts[0]) && validPart(parts[1]) && parts[1] === item.marketplace;
}

function canReactivateLocalGeminiItem(item: DeviceInventoryItem, localItems: DeviceInventoryItem[]): boolean {
  return item.provider === "gemini"
    && item.kind === "plugin"
    && item.enabled
    && localItems.some((local) => local.provider === "gemini" && local.kind === "plugin" && local.key === item.key && local.installed);
}

export function readInventorySyncPreference(owner?: string, storage: Storage = window.localStorage): boolean {
  return Boolean(owner) && storage.getItem(inventoryPreferenceKey(owner)) === "true";
}

export function writeInventorySyncPreference(owner: string, enabled: boolean, storage: Storage = window.localStorage): void {
  storage.setItem(inventoryPreferenceKey(owner), String(enabled));
}

function inventoryPreferenceKey(owner?: string): string {
  return `${INVENTORY_SYNC_KEY}:${stableId(owner)}`;
}

function inventoryItemFingerprint(item: DeviceInventoryItem): string {
  return JSON.stringify([
    item.provider,
    item.kind,
    item.key,
    item.displayName,
    item.version ?? null,
    item.enabled,
    item.installed,
    item.source,
    item.marketplace ?? null,
    item.transport ?? null,
    item.hasSecrets,
    item.transferable,
    item.blockedReason ?? null,
  ]);
}

function inventorySyncErrorMessage(cause: unknown): string {
  const detail = message(cause);
  const normalized = detail.toLowerCase();
  if (normalized.includes("pgrst205") || (normalized.includes("device_setting_snapshots") && normalized.includes("404"))) {
    return "기기 설정 동기화용 서버 테이블이 아직 준비되지 않았습니다. 기존 토큰 동기화는 계속됩니다.";
  }
  return `기기 설정 목록을 동기화하지 못했습니다. ${detail.slice(0, 240)}`;
}

function localUsageOwnershipKey(event: LocalUsageEvent): string {
  return event.id;
}

function readSessionTitles(owner: string | undefined): Record<string, string> {
  if (!owner) return readJson(TITLES_KEY, {});
  return readJson<Record<string, Record<string, string>>>(TITLES_BY_OWNER_KEY, {})[owner] ?? {};
}

function writeSessionTitles(owner: string | undefined, titles: Record<string, string>): void {
  if (!owner) {
    window.localStorage.setItem(TITLES_KEY, JSON.stringify(titles));
    return;
  }
  const byOwner = readJson<Record<string, Record<string, string>>>(TITLES_BY_OWNER_KEY, {});
  window.localStorage.setItem(TITLES_BY_OWNER_KEY, JSON.stringify({ ...byOwner, [owner]: titles }));
}
function readJson<T>(key: string, fallback: T): T {
  return readJsonFromStorage(window.localStorage, key, fallback);
}
function readJsonFromStorage<T>(storage: Storage, key: string, fallback: T): T {
  try { return JSON.parse(storage.getItem(key) ?? "") as T; } catch { return fallback; }
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
