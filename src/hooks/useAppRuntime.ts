// 로컬 수집, 계정 동기화, 공급사 사용량 조회를 하나의 앱 런타임으로 연결하는 훅
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sanitizeProjectName, type Provider, type TokenBreakdown, type UsageEvent as LocalUsageEvent } from "../core";
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
  type CredentialKey,
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
import {
  fallbackDeviceName,
  getCurrentDeviceInfo,
  saveLocalUsageState,
  type CurrentDeviceInfo,
  type LocalUsageOwnershipState,
} from "../platform/tauri";
import { getOrCreateDeviceId, useLocalUsage } from "./useLocalUsage";

const SESSION_KEY = "token-deck-supabase-session";
const TITLES_KEY = "token-deck-session-titles";
const TITLES_BY_OWNER_KEY = "token-deck-session-titles-by-owner";
const PROJECT_NAMES_BY_OWNER_KEY = "token-deck-project-names-by-owner";
const LOCAL_OWNERSHIP_KEY = "token-deck-local-session-owners";
const CONFIG_KEY = "token-deck-supabase-config";
const SESSION_TOMBSTONES_KEY = "token-deck-supabase-session-tombstones";
const PENDING_SESSION_CREDENTIAL = "supabase-pending" as CredentialKey;
const INVENTORY_SYNC_KEY = "token-deck-device-inventory-sync";
const INVENTORY_SYNC_LOGIN_CONSENT_KEY = "token-deck-inventory-login-consent";
const FULL_RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const LOCAL_USAGE_SEEN_FILTER_BYTES = 1024 * 1024;
const LOCAL_USAGE_SEEN_FILTER_HASHES = 8;
const ALL_USAGE_PROVIDERS: Provider[] = ["codex", "claude", "gemini"];
const ALL_CREDENTIAL_PROVIDERS: CredentialProvider[] = ["openai", "anthropic", "google"];
const CREDENTIAL_PROVIDER_BY_USAGE: Record<Provider, CredentialProvider> = { codex: "openai", claude: "anthropic", gemini: "google" };
const USAGE_PROVIDER_BY_CREDENTIAL: Record<CredentialProvider, Provider> = { openai: "codex", anthropic: "claude", google: "gemini" };
const USAGE_PROVIDER_BY_SYNC: Record<string, Provider> = { openai: "codex", anthropic: "claude", google: "gemini", codex: "codex", claude: "claude", gemini: "gemini" };

export function syncProvidersForUsageProviders(providers: Provider[]): SyncUsageEvent["provider"][] {
  return providers.flatMap((provider) => [provider, CREDENTIAL_PROVIDER_BY_USAGE[provider]]);
}

type AuthStatus = "local" | "signed_out" | "authenticated";
type CloudSyncStatus = "disabled" | "signed_out" | "idle" | "syncing" | "offline" | "error";
type InventorySyncStatus = "disabled" | "signed_out" | "idle" | "syncing" | "error";

interface CredentialStatus { configured: boolean; checking: boolean; error?: string }

export interface CredentialRevisionTracker {
  current(provider: CredentialProvider): number;
  invalidate(provider: CredentialProvider): number;
  matches(provider: CredentialProvider, revision: number): boolean;
}

export function createCredentialRevisionTracker(): CredentialRevisionTracker {
  const revisions: Record<CredentialProvider, number> = { openai: 0, anthropic: 0, google: 0 };
  return {
    current: (provider) => revisions[provider],
    invalidate: (provider) => ++revisions[provider],
    matches: (provider, revision) => revisions[provider] === revision,
  };
}

export async function runCredentialMutation<T>(
  revisions: CredentialRevisionTracker,
  provider: CredentialProvider,
  mutation: () => Promise<T>,
): Promise<T> {
  revisions.invalidate(provider);
  try {
    return await mutation();
  } finally {
    revisions.invalidate(provider);
  }
}

export function useAppRuntime(enabledProviders: Provider[] = ALL_USAGE_PROVIDERS) {
  const providerKey = enabledProviders.join("|");
  const currentProviderKey = useRef(providerKey);
  currentProviderKey.current = providerKey;
  const selectedCredentialProviders = useMemo(
    () => enabledProviders.map((provider) => CREDENTIAL_PROVIDER_BY_USAGE[provider]),
    [providerKey],
  );
  const localOwnershipRef = useRef<LocalUsageOwnershipState | undefined>(undefined);
  const localOwnershipLoadRef = useRef<Promise<LocalUsageOwnershipState> | undefined>(undefined);
  const localOwnershipBaselineRef = useRef<LocalUsageEvent[]>([]);
  const localOwnershipBaselineStateRef = useRef<LocalUsageOwnershipState | null>(null);
  const localCodexCumulativeBaselineRef = useRef<Record<string, TokenBreakdown>>({});
  const localCodexRetiredSessionFilterBaselineRef = useRef("");
  const localOwnershipOwnerHashRef = useRef<string | undefined>(undefined);
  const localOwnershipMutationRef = useRef<Promise<void>>(Promise.resolve());
  const [localOwnershipRevision, setLocalOwnershipRevision] = useState(0);
  const ensureLocalUsageOwnership = useCallback(async (
    baselineEvents: LocalUsageEvent[],
  ): Promise<LocalUsageOwnershipState> => {
    if (localOwnershipRef.current) return localOwnershipRef.current;
    if (localOwnershipLoadRef.current) return localOwnershipLoadRef.current;
    const task = (async () => {
      const loaded = localOwnershipBaselineStateRef.current;
      const initial = loaded ?? migrateLocalUsageOwnership(
        baselineEvents,
        readLegacyLocalUsageOwnership(window.localStorage),
      );
      const prepared = loaded
        ? pruneLocalUsageOwnership(initial, baselineEvents)
        : sealLocalUsageOwnershipBaseline(initial, baselineEvents);
      if (!loaded || prepared !== loaded) {
        await saveLocalUsageState(
          baselineEvents,
          prepared,
          localCodexCumulativeBaselineRef.current,
          localCodexRetiredSessionFilterBaselineRef.current,
        );
      }
      localOwnershipRef.current = prepared;
      setLocalOwnershipRevision((current) => current + 1);
      try { window.localStorage.removeItem(LOCAL_OWNERSHIP_KEY); } catch { /* 네이티브 이전은 이미 완료됐다. */ }
      return prepared;
    })();
    localOwnershipLoadRef.current = task;
    try {
      return await task;
    } finally {
      if (localOwnershipLoadRef.current === task) localOwnershipLoadRef.current = undefined;
    }
  }, []);
  const prepareLocalUsageOwnership = useCallback(async (
    events: LocalUsageEvent[],
    ownership: LocalUsageOwnershipState | null,
    codexCumulative: Record<string, TokenBreakdown>,
    codexRetiredSessionFilter: string,
  ): Promise<void> => {
    localOwnershipBaselineRef.current = events;
    localOwnershipBaselineStateRef.current = ownership;
    localCodexCumulativeBaselineRef.current = codexCumulative;
    localCodexRetiredSessionFilterBaselineRef.current = codexRetiredSessionFilter;
    try {
      await ensureLocalUsageOwnership(events);
    } catch { /* 로컬 화면은 유지하고 계정 동기화만 안전하게 차단한다. */ }
  }, [ensureLocalUsageOwnership]);
  const updateLocalUsageOwnership = useCallback((
    events: LocalUsageEvent[],
    ownerHash: string | undefined,
    retainedEvents: LocalUsageEvent[],
    codexCumulative: Record<string, TokenBreakdown>,
    codexRetiredSessionFilter: string,
    persistSnapshot = false,
  ): Promise<LocalUsageEvent[]> => {
    const run = localOwnershipMutationRef.current.catch(() => undefined).then(async () => {
      const loaded = await ensureLocalUsageOwnership(localOwnershipBaselineRef.current);
      const snapshot = selectLocalUsagePersistenceSnapshot(
        persistSnapshot,
        retainedEvents,
        codexCumulative,
        codexRetiredSessionFilter,
        localOwnershipBaselineRef.current,
        localCodexCumulativeBaselineRef.current,
        localCodexRetiredSessionFilterBaselineRef.current,
      );
      const retained = pruneLocalUsageOwnership(loaded, snapshot.events);
      const claimEvents = selectRetainedLocalUsageClaimEvents(events, snapshot.events);
      const claim = ownerHash
        ? claimAccountLocalEvents(retained, claimEvents, ownerHash)
        : { events: [] as LocalUsageEvent[], ownership: retained };
      if (persistSnapshot || claim.ownership !== loaded) {
        await saveLocalUsageState(
          snapshot.events,
          claim.ownership,
          snapshot.codexCumulative,
          snapshot.codexRetiredSessionFilter,
        );
        localOwnershipBaselineRef.current = snapshot.events;
        localCodexCumulativeBaselineRef.current = snapshot.codexCumulative;
        localCodexRetiredSessionFilterBaselineRef.current = snapshot.codexRetiredSessionFilter;
        localOwnershipRef.current = claim.ownership;
        setLocalOwnershipRevision((current) => current + 1);
      }
      return claim.events;
    });
    localOwnershipMutationRef.current = run.then(() => undefined, () => undefined);
    return run;
  }, [ensureLocalUsageOwnership]);
  const getLocalUsageOwnerHash = useCallback(() => localOwnershipOwnerHashRef.current, []);
  const persistLocalUsageSnapshot = useCallback(async (
    events: LocalUsageEvent[],
    incoming: LocalUsageEvent[],
    codexCumulative: Record<string, TokenBreakdown>,
    codexRetiredSessionFilter: string,
    ownerHash?: string,
  ): Promise<void> => {
    const retainedIds = new Set(events.map((event) => event.id));
    await updateLocalUsageOwnership(
      incoming.filter((event) => retainedIds.has(event.id)),
      ownerHash,
      events,
      codexCumulative,
      codexRetiredSessionFilter,
      true,
    );
  }, [updateLocalUsageOwnership]);
  const local = useLocalUsage(
    enabledProviders,
    prepareLocalUsageOwnership,
    getLocalUsageOwnerHash,
    persistLocalUsageSnapshot,
  );
  const [runtimeConfig, setRuntimeConfig] = useState<SupabaseConfig | null>(() => {
    const allowOverride = import.meta.env.DEV;
    const saved = allowOverride ? readJson<SupabaseConfig | null>(CONFIG_KEY, null) : null;
    const legacyStateCleared = clearProductionSupabaseOverride(window.localStorage, allowOverride);
    return legacyStateCleared ? resolveSupabaseConfig(saved, readSupabaseConfig(), allowOverride) : null;
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
  const [remoteProjectNames, setRemoteProjectNames] = useState<Record<string, string>>({});
  const [accountProjectNameOverrides, setAccountProjectNameOverrides] = useState<Record<string, string>>({});
  const [devices, setDevices] = useState<DeviceRegistration[]>(() => [currentDevice()]);
  const [localInventory, setLocalInventory] = useState<DeviceInventory>();
  const [deviceInventories, setDeviceInventories] = useState<DeviceInventorySnapshot[]>([]);
  const [inventorySyncEnabled, setInventorySyncEnabledState] = useState(false);
  const [inventorySyncPreferenceSet, setInventorySyncPreferenceSet] = useState(false);
  const [inventorySync, setInventorySync] = useState<{ status: InventorySyncStatus; loading: boolean; error?: string }>({
    status: "disabled",
    loading: true,
  });
  const [providerEvents, setProviderEvents] = useState<SyncUsageEvent[]>([]);
  const [sessionTitles, setSessionTitles] = useState<Record<string, string>>(() => readSessionTitles(undefined));
  const sessionTitlesRef = useRef(sessionTitles);
  sessionTitlesRef.current = sessionTitles;
  const accountGenerationRef = useRef(0);
  const authAttemptGenerationRef = useRef(0);
  const accountOwnerRef = useRef<string | undefined>(undefined);
  const providerEventsOwnerRef = useRef<string | undefined>(undefined);
  const credentialRevisionRef = useRef(createCredentialRevisionTracker());
  const localInventoryRef = useRef<DeviceInventory | undefined>(undefined);
  const currentDeviceInfoRef = useRef<CurrentDeviceInfo>(fallbackCurrentDeviceInfo());
  const inventorySyncEnabledRef = useRef(false);
  const inventorySyncRevisionRef = useRef(0);
  const inventorySyncCompletedRevisionRef = useRef(-1);
  const inventorySyncErrorRef = useRef<string | undefined>(undefined);
  const serializeSyncRef = useRef(createSerialTaskRunner());
  const syncCacheRef = useRef(createUsageSyncCache());
  const syncCacheProviderKeyRef = useRef("");
  const credentialOwner = providerCredentialOwner(auth.status, auth.userId, client.config, getOrCreateDeviceId());
  const credentialOwnerRef = useRef<string | undefined>(credentialOwner);
  credentialOwnerRef.current = credentialOwner;
  localOwnershipOwnerHashRef.current = auth.status === "authenticated"
    ? localUsageOwnerHash(
      client.config?.url,
      client.currentSession?.userId ?? auth.userId ?? (client.currentSession?.accessToken ? jwtSubject(client.currentSession.accessToken) : undefined),
    )
    : undefined;

  useEffect(() => {
    const deviceId = getOrCreateDeviceId();
    void getCurrentDeviceInfo(deviceId).then((info) => {
      currentDeviceInfoRef.current = info;
      setDevices((current) => {
        const registration = currentDevice(info);
        const found = current.some((device) => device.id === deviceId);
        return found
          ? current.map((device) => device.id === deviceId ? { ...device, ...registration, lastSeenAt: device.lastSeenAt } : device)
          : [registration, ...current];
      });
    });
  }, []);

  const clearAccountProviderState = useCallback(() => {
    ALL_CREDENTIAL_PROVIDERS.forEach((provider) => credentialRevisionRef.current.invalidate(provider));
    providerEventsOwnerRef.current = undefined;
    setProviderEvents([]);
    setProviderUsage([]);
    setCredentials(emptyCredentialStatus());
    syncCacheRef.current = createUsageSyncCache();
    syncCacheProviderKeyRef.current = "";
  }, []);

  const clearAccountInventoryState = useCallback(() => {
    setDeviceInventories([]);
    inventorySyncRevisionRef.current += 1;
    inventorySyncCompletedRevisionRef.current = -1;
    inventorySyncErrorRef.current = undefined;
    inventorySyncEnabledRef.current = false;
    setInventorySyncEnabledState(false);
    setInventorySyncPreferenceSet(false);
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
    const currentOwner = accountOwnerRef.current;
    const nextOwner = accountOwner(scope, complete);
    return commitSession(complete, generation, scope, {
      currentGeneration: () => accountGenerationRef.current,
      currentScope: () => sessionScope(client.config),
      stage: stageSession,
      discardPending: removePendingSessionIfMarker,
      promote: promotePendingSession,
      discardPromoted: removeActiveSessionIfMarker,
      beforeAccept: async () => {
        if (currentOwner !== accountOwnerRef.current) return false;
        if (!await flushLocalUsageAccountBoundary(currentOwner, nextOwner, local.refreshAfterPending)) {
          throw new Error("현재 계정의 로컬 사용량을 안전하게 저장하지 못해 계정 전환을 중단했습니다.");
        }
        return currentOwner === accountOwnerRef.current;
      },
      accept: (accepted) => {
        const nextOwner = accountOwner(scope, accepted);
        if (resetProviderState || accountOwnerRef.current !== nextOwner) {
          accountGenerationRef.current += 1;
          clearAccountProviderState();
          setRemoteEvents([]);
          setRemoteAccountEvents([]);
          setRemoteProjectNames({});
          setAccountProjectNameOverrides(readAccountProjectNameOverrides(nextOwner));
          setDevices([currentDevice(currentDeviceInfoRef.current)]);
          setSessionTitles(readSessionTitles(nextOwner));
          clearAccountInventoryState();
          const storedPreference = hasInventorySyncPreference(nextOwner);
          const loginConsent = consumeInventoryLoginConsent();
          const enabled = Boolean(nextOwner && (storedPreference ? readInventorySyncPreference(nextOwner) : loginConsent));
          if (nextOwner && !storedPreference && loginConsent) writeInventorySyncPreference(nextOwner, true);
          inventorySyncEnabledRef.current = enabled;
          setInventorySyncEnabledState(enabled);
          setInventorySyncPreferenceSet(Boolean(nextOwner && (storedPreference || loginConsent)));
          setInventorySync({ status: enabled ? "idle" : "disabled", loading: false });
        }
        clearSessionTombstone(scope);
        accountOwnerRef.current = nextOwner;
        localOwnershipOwnerHashRef.current = localUsageOwnerHash(client.config?.url, accepted.userId);
        credentialOwnerRef.current = nextOwner;
        authService.acceptSession(accepted);
        setAuth({ enabled: true, status: "authenticated", userId: accepted.userId });
        setCloudSync((current) => ({ ...current, status: "idle", error: undefined }));
      },
    });
  }, [authService, clearAccountInventoryState, clearAccountProviderState, client.config, local.refreshAfterPending]);

  const refreshCredentialStatus = useCallback(async () => {
    const providers = ALL_CREDENTIAL_PROVIDERS;
    const generation = accountGenerationRef.current;
    if (!credentialOwner) {
      setCredentials(emptyCredentialStatus());
      return;
    }
    const checking = emptyCredentialStatus();
    providers.forEach((provider) => { checking[provider] = { configured: false, checking: true }; });
    setCredentials(checking);
    const results = await Promise.all(providers.map(async (provider) => {
      try {
        return [provider, { configured: Boolean(await loadOwnedProviderSecret(provider, credentialOwner)), checking: false }] as const;
      } catch (cause) {
        return [provider, { configured: false, checking: false, error: message(cause) }] as const;
      }
    }));
    if (generation !== accountGenerationRef.current || credentialOwnerRef.current !== credentialOwner) return;
    const next = emptyCredentialStatus();
    results.forEach(([provider, status]) => { next[provider] = status; });
    setCredentials(next);
  }, [credentialOwner]);

  useEffect(() => { void refreshCredentialStatus(); }, [refreshCredentialStatus]);

  useEffect(() => {
    if (!client.enabled) return;
    const generation = accountGenerationRef.current;
    let cancelled = false;
    const restore = async () => {
      try {
        await serializeSyncRef.current(async () => {
          if (cancelled || generation !== accountGenerationRef.current) return;
          await clearStalePendingSession();
          const saved = await loadStoredSession(sessionScope(client.config));
          if (!saved?.accessToken && !saved?.refreshToken) return;
          const session = saved.refreshToken && (
            !saved.accessToken
            || Boolean(saved.expiresAt && saved.expiresAt <= Math.floor(Date.now() / 1000) + 30)
          )
            ? await authService.refresh(saved.refreshToken)
            : saved;
          if (cancelled || generation !== accountGenerationRef.current) return;
          await activateSession(session, generation, sessionScope(client.config), true);
        });
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
    setAuth((current) => ({ ...current, error: undefined }));
    authAttemptGenerationRef.current += 1;
    const state = crypto.randomUUID();
    const { verifier, challenge } = await createPkcePair();
    window.localStorage.setItem(AUTH_STATE_KEY, state);
    window.localStorage.setItem(AUTH_PKCE_VERIFIER_KEY, verifier);
    markInventoryLoginConsent();
    try {
      await authService.sendMagicLink(email, authRedirectWithState(state, redirectTo ?? AUTH_REDIRECT_URL), challenge);
    } catch (cause) {
      if (window.localStorage.getItem(AUTH_STATE_KEY) === state) window.localStorage.removeItem(AUTH_STATE_KEY);
      if (window.localStorage.getItem(AUTH_PKCE_VERIFIER_KEY) === verifier) window.localStorage.removeItem(AUTH_PKCE_VERIFIER_KEY);
      clearInventoryLoginConsent();
      throw cause;
    }
  }, [authService, client.enabled]);

  const signInWithGoogle = useCallback(async () => {
    if (!client.enabled) throw new Error("Supabase 환경 설정이 없어 로컬 전용 모드입니다.");
    setAuth((current) => ({ ...current, error: undefined }));
    await authService.ensureGoogleProviderEnabled();
    authAttemptGenerationRef.current += 1;
    const state = crypto.randomUUID();
    const { verifier, challenge } = await createPkcePair();
    window.localStorage.setItem(AUTH_STATE_KEY, state);
    window.localStorage.setItem(AUTH_PKCE_VERIFIER_KEY, verifier);
    markInventoryLoginConsent();
    try {
      const redirectTo = authRedirectWithState(state, AUTH_REDIRECT_URL);
      await openExternalBrowser(authService.createGoogleOAuthUrl(redirectTo, challenge));
    } catch (cause) {
      if (window.localStorage.getItem(AUTH_STATE_KEY) === state) window.localStorage.removeItem(AUTH_STATE_KEY);
      if (window.localStorage.getItem(AUTH_PKCE_VERIFIER_KEY) === verifier) window.localStorage.removeItem(AUTH_PKCE_VERIFIER_KEY);
      clearInventoryLoginConsent();
      throw cause;
    }
  }, [authService, client.enabled]);

  const cancelPendingAuth = useCallback(() => {
    cancelPendingAuthAttempt(authAttemptGenerationRef, accountGenerationRef);
  }, []);

  const acceptAuthRedirect = useCallback(async (url: string) => {
    const generation = accountGenerationRef.current;
    const attemptGeneration = authAttemptGenerationRef.current;
    const scope = sessionScope(client.config);
    verifyAuthRedirectState(url, window.localStorage.getItem(AUTH_STATE_KEY));
    const codeVerifier = window.localStorage.getItem(AUTH_PKCE_VERIFIER_KEY) ?? "";
    window.localStorage.removeItem(AUTH_STATE_KEY);
    window.localStorage.removeItem(AUTH_PKCE_VERIFIER_KEY);
    const code = requireOneTimeAuthCode(url);
    try {
      const session = await authService.exchangeCodeForSession(code, codeVerifier);
      await serializeSyncRef.current(() => (
        attemptGeneration === authAttemptGenerationRef.current
          ? activateSession(session, generation, scope, true)
          : Promise.resolve(false)
      ));
    } catch (cause) {
      clearInventoryLoginConsent();
      throw cause;
    }
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
    const boundaryOwner = accountOwnerRef.current;
    const boundaryGeneration = accountGenerationRef.current;
    if (!await flushLocalUsageAccountBoundary(boundaryOwner, undefined, local.refreshAfterPending)) {
      setAuth((current) => ({
        ...current,
        error: "현재 계정의 로컬 사용량을 안전하게 저장하지 못해 로그아웃을 중단했습니다.",
      }));
      return;
    }
    if (boundaryGeneration !== accountGenerationRef.current || boundaryOwner !== accountOwnerRef.current) return;
    const scope = sessionScope(client.config);
    const localErrors: string[] = [];
    try { markSessionTombstone(scope); } catch (cause) { localErrors.push(`로그아웃 표시 저장 실패: ${message(cause)}`); }
    const remoteLogoutController = new AbortController();
    const remoteLogout = settleWithin(
      authService.signOutRemotely(remoteLogoutController.signal),
      2_000,
      () => remoteLogoutController.abort(),
    );
    const generation = ++accountGenerationRef.current;
    authService.signOutLocally();
    accountOwnerRef.current = undefined;
    localOwnershipOwnerHashRef.current = undefined;
    credentialOwnerRef.current = localProviderCredentialOwner(getOrCreateDeviceId());
    clearAccountProviderState();
    clearAccountInventoryState();
    window.localStorage.removeItem(SESSION_KEY);
    window.localStorage.removeItem(AUTH_STATE_KEY);
    window.localStorage.removeItem(AUTH_PKCE_VERIFIER_KEY);
    clearInventoryLoginConsent();
    setAuth({ enabled: client.enabled, status: client.enabled ? "signed_out" : "local" });
    setRemoteEvents([]);
    setRemoteAccountEvents([]);
    setRemoteProjectNames({});
    setAccountProjectNameOverrides({});
    setDevices([currentDevice(currentDeviceInfoRef.current)]);
    setSessionTitles(readSessionTitles(undefined));
    setCloudSync({ status: client.enabled ? "signed_out" : "disabled", uploaded: 0, pending: 0 });
    const credentialRemoval = Promise.allSettled([
      removeProviderSecret("supabase"),
      removeProviderSecret(PENDING_SESSION_CREDENTIAL),
    ]);
    const [remoteOutcome, [activeCredentialOutcome, pendingCredentialOutcome]] = await Promise.all([remoteLogout, credentialRemoval]);
    const errors = [
      ...localErrors,
      ...(remoteOutcome.status === "rejected" ? [`원격 로그아웃 실패: ${message(remoteOutcome.reason)}`] : []),
      ...(remoteOutcome.status === "timed_out" ? ["원격 로그아웃 응답이 지연되어 로컬 로그아웃만 완료했습니다."] : []),
      ...(activeCredentialOutcome.status === "rejected" ? [`저장된 세션 삭제 실패: ${message(activeCredentialOutcome.reason)}`] : []),
      ...(pendingCredentialOutcome.status === "rejected" ? [`전환 대기 세션 삭제 실패: ${message(pendingCredentialOutcome.reason)}`] : []),
    ];
    if (errors.length && generation === accountGenerationRef.current) {
      setAuth({ enabled: client.enabled, status: client.enabled ? "signed_out" : "local", error: errors.join(" ") });
    }
  }, [authService, clearAccountInventoryState, clearAccountProviderState, client.config, client.enabled, local.refreshAfterPending]);

  const syncDeviceInventoriesForOwner = useCallback(async (
    generation: number,
    activeOwner: string,
    currentPhysicalDeviceId: string,
  ): Promise<void> => {
    if (generation !== accountGenerationRef.current || activeOwner !== accountOwnerRef.current) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      const error = "오프라인 상태라 기기 설정 목록을 동기화하지 못했습니다.";
      inventorySyncErrorRef.current = error;
      setInventorySync({ status: "error", loading: false, error });
      return;
    }

    const uploadEnabled = inventorySyncEnabledRef.current;
    const inventoryRevision = inventorySyncRevisionRef.current;
    const errors: string[] = [];
    let uploadCompleted = !uploadEnabled;
    inventorySyncCompletedRevisionRef.current = -1;
    inventorySyncErrorRef.current = undefined;
    setInventorySync({ status: "syncing", loading: true });

    if (uploadEnabled) {
      try {
        const cachedInventory = localInventoryRef.current;
        const inventory = !cachedInventory || Date.now() - cachedInventory.capturedAt > 5 * 60 * 1_000
          ? await refreshDeviceInventory()
          : cachedInventory;
        if (generation !== accountGenerationRef.current || activeOwner !== accountOwnerRef.current) return;
        if (inventoryRevision === inventorySyncRevisionRef.current && inventorySyncEnabledRef.current) {
          if (!inventory) throw new Error("현재 기기의 설정 목록을 수집하지 못했습니다.");
          const result = await syncService.upsertDeviceInventorySnapshot(
            createDeviceInventorySnapshot(currentPhysicalDeviceId, inventory),
          );
          if (generation !== accountGenerationRef.current || activeOwner !== accountOwnerRef.current) return;
          if (result.error) throw new Error(result.error);
          uploadCompleted = true;
        }
      } catch (cause) {
        errors.push(inventorySyncErrorMessage(cause));
      }
    }

    if (generation !== accountGenerationRef.current || activeOwner !== accountOwnerRef.current) return;
    try {
      const snapshots = await syncService.listDeviceInventorySnapshots();
      if (generation !== accountGenerationRef.current || activeOwner !== accountOwnerRef.current) return;
      setDeviceInventories(snapshots);
    } catch (cause) {
      errors.push(inventorySyncErrorMessage(cause));
    }

    if (generation !== accountGenerationRef.current || activeOwner !== accountOwnerRef.current) return;
    if (uploadCompleted && uploadEnabled && inventoryRevision === inventorySyncRevisionRef.current) {
      inventorySyncCompletedRevisionRef.current = inventoryRevision;
    }
    if (errors.length) {
      const error = [...new Set(errors)].join(" ");
      inventorySyncErrorRef.current = error;
      setInventorySync({ status: "error", loading: false, error });
    } else {
      setInventorySync({ status: inventorySyncEnabledRef.current ? "idle" : "disabled", loading: false });
    }
  }, [refreshDeviceInventory, syncService]);

  const enqueueSync = useCallback((generation: number, selectedProviderKey: string) => serializeSyncRef.current(async () => {
    if (generation !== accountGenerationRef.current || selectedProviderKey !== currentProviderKey.current) return;
    if (!local.cacheReady) return;
    if (!await local.refresh()) return;
    if (generation !== accountGenerationRef.current || selectedProviderKey !== currentProviderKey.current) return;
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
    if (selectedProviderKey !== currentProviderKey.current) return;
    const localOwnerHash = localUsageOwnerHash(
      client.config?.url,
      client.currentSession.userId ?? jwtSubject(client.currentSession.accessToken),
    );
    if (!localOwnerHash) {
      setCloudSync((current) => ({ ...current, status: "error", error: "로컬 사용량을 귀속할 계정 식별자를 확인할 수 없습니다." }));
      return;
    }
    const ownedProviderEvents = providerEventsForOwner(providerEvents, providerEventsOwnerRef.current, activeOwner)
      .filter((event) => syncEventProviderEnabled(event, enabledProviders));
    let ownedLocalEvents: LocalUsageEvent[];
    try {
      ownedLocalEvents = await updateLocalUsageOwnership(
        local.events,
        localOwnerHash,
        local.allEvents,
        local.getCodexCumulative(),
        local.getCodexRetiredSessionFilter(),
      );
      if (generation !== accountGenerationRef.current || activeOwner !== accountOwnerRef.current) return;
    } catch (cause) {
      if (generation !== accountGenerationRef.current || activeOwner !== accountOwnerRef.current) return;
      const error = `로컬 사용량 소유권을 안전하게 저장하지 못해 계정 동기화를 중단했습니다. ${message(cause)}`;
      setCloudSync((current) => ({ ...current, status: "error", error }));
      return;
    }
    const titled = localEventsToTitledSyncEvents(ownedLocalEvents, sessionTitlesRef.current);
    const outgoing = deduplicateSyncEvents([...titled, ...ownedProviderEvents]);
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setCloudSync((current) => ({ ...current, status: "offline", pending: outgoing.length, error: "네트워크가 복구되면 자동으로 다시 시도합니다." }));
      return;
    }
    if (syncCacheRef.current.owner !== activeOwner || syncCacheProviderKeyRef.current !== selectedProviderKey) {
      syncCacheRef.current = createUsageSyncCache(activeOwner);
      syncCacheProviderKeyRef.current = selectedProviderKey;
    }
    const cache = syncCacheRef.current;
    const cycleStartedAt = Date.now();
    const fullReconcile = shouldFullyReconcile(cache, cycleStartedAt);
    const currentPhysicalDeviceId = getOrCreateDeviceId();
    const activeAccountIsCurrent = () => generation === accountGenerationRef.current
      && activeOwner === accountOwnerRef.current
      && selectedProviderKey === currentProviderKey.current;
    setCloudSync((current) => ({ ...current, status: "syncing", pending: outgoing.length, error: undefined }));
    let usageError: string | undefined;
    let uploaded = 0;
    let registrationError: string | undefined;
    let downloadedUsageChanged = false;
    let remoteUsagePublished = false;
    const publishRemoteUsage = () => {
      const combinedRemote = [...cache.remoteEvents.values()];
      setRemoteEvents(combinedRemote.flatMap(toLocalUsageEvent));
      setRemoteAccountEvents(combinedRemote.filter((event) => event.source === "provider_api" || event.source === "cloud_billing"));
      const mergedTitles = mergeSessionTitles(sessionTitlesRef.current, combinedRemote);
      sessionTitlesRef.current = mergedTitles;
      setSessionTitles(mergedTitles);
      writeSessionTitles(activeOwner, mergedTitles);
      remoteUsagePublished = true;
    };
    try {
      const deviceInfo = await getCurrentDeviceInfo(currentPhysicalDeviceId);
      if (!activeAccountIsCurrent()) return;
      currentDeviceInfoRef.current = deviceInfo;
      const deviceResult = await syncService.registerDevice(currentDevice(deviceInfo));
      if (!activeAccountIsCurrent()) return;
      if (deviceResult.error) registrationError = deviceResult.error;
    } catch (cause) {
      if (!activeAccountIsCurrent()) return;
      registrationError = message(cause);
    }
    try {
      const downloaded = await syncService.listUsageEvents(
        fullReconcile ? undefined : cache.cursor,
        fullReconcile ? undefined : currentPhysicalDeviceId,
        syncProvidersForUsageProviders(enabledProviders),
        activeAccountIsCurrent,
      );
      if (!activeAccountIsCurrent()) return;
      downloadedUsageChanged = reconcileDownloadedUsage(cache, downloaded, fullReconcile, cycleStartedAt);
      const changed = selectChangedUsageEvents(cache, outgoing);
      setCloudSync((current) => ({ ...current, pending: changed.length }));
      if (downloadedUsageChanged && changed.length === 0) publishRemoteUsage();
      if (registrationError) throw new Error(`현재 기기 등록 실패. ${registrationError}`);
      if (changed.some((event) => event.source === "provider_api" || event.source === "cloud_billing")) {
        if (!activeAccountIsCurrent()) return;
        const accountDeviceResult = await syncService.registerDevice({
          id: ACCOUNT_PROVIDER_DEVICE_ID,
          name: "계정 API 집계",
          platform: "account",
          appVersion: "0.5.4",
          lastSeenAt: new Date().toISOString(),
        });
        if (!activeAccountIsCurrent()) return;
        if (accountDeviceResult.error) throw new Error(accountDeviceResult.error);
      }
      if (!activeAccountIsCurrent()) return;
      const result = await syncService.upsertUsageEvents(
        changed,
        mergeAccountProjectNames(local.inferredProjectNames, remoteProjectNames, accountProjectNameOverrides),
        { shouldContinue: activeAccountIsCurrent },
      );
      if (!activeAccountIsCurrent()) return;
      if (result.error) throw new Error(result.error);
      uploaded = result.uploaded;
      recordUploadedUsage(cache, changed);
      if (!remoteUsagePublished && (downloadedUsageChanged || changed.length > 0)) publishRemoteUsage();
      setCloudSync({ status: "idle", uploaded: result.uploaded, pending: 0, lastSyncedAt: new Date() });
    } catch (cause) {
      if (!activeAccountIsCurrent()) return;
      if (downloadedUsageChanged && !remoteUsagePublished) publishRemoteUsage();
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      usageError = message(cause);
      setCloudSync((current) => ({ ...current, status: offline ? "offline" : "error", pending: outgoing.length, error: usageError }));
    }

    if (generation !== accountGenerationRef.current || activeOwner !== accountOwnerRef.current) return;
    const [deviceList, projectList] = await Promise.allSettled([
      syncService.listDevices(),
      syncService.listProjects(),
    ]);
    if (generation !== accountGenerationRef.current || activeOwner !== accountOwnerRef.current) return;
    if (deviceList.status === "fulfilled") {
      const physicalDevices = deviceList.value.filter((device) => device.id !== ACCOUNT_PROVIDER_DEVICE_ID);
      setDevices(physicalDevices.length ? physicalDevices : [currentDevice(currentDeviceInfoRef.current)]);
    }
    if (projectList.status === "fulfilled") {
      setRemoteProjectNames(Object.fromEntries(projectList.value.map((project) => [project.id, project.name])));
    }
    const metadataErrors = [
      deviceList.status === "rejected" ? `기기 목록 조회 실패. ${message(deviceList.reason)}` : "",
      projectList.status === "rejected" ? `프로젝트 이름 조회 실패. ${message(projectList.reason)}` : "",
    ].filter(Boolean);
    if (!usageError && metadataErrors.length) {
      setCloudSync((current) => ({ ...current, status: "error", uploaded, error: metadataErrors.join(" ") }));
    }
    await syncDeviceInventoriesForOwner(generation, activeOwner, currentPhysicalDeviceId);
  }), [accountProjectNameOverrides, activateSession, auth.status, authService, client, enabledProviders, local.allEvents, local.cacheReady, local.events, local.getCodexCumulative, local.getCodexRetiredSessionFilter, local.inferredProjectNames, local.refresh, providerEvents, remoteProjectNames, signOut, syncDeviceInventoriesForOwner, syncService, updateLocalUsageOwnership]);
  const syncNow = useCallback(
    () => enqueueSync(accountGenerationRef.current, providerKey),
    [enqueueSync, providerKey],
  );

  const syncNowRef = useRef(syncNow);
  syncNowRef.current = syncNow;
  useEffect(() => {
    if (auth.status !== "authenticated") return;
    const retry = () => void syncNowRef.current();
    window.addEventListener("online", retry);
    const timer = window.setInterval(retry, 60_000);
    void syncNowRef.current();
    return () => { window.removeEventListener("online", retry); window.clearInterval(timer); };
  }, [auth.status, local.cacheReady, providerKey]);

  const refreshAndSyncDeviceInventory = useCallback(async (): Promise<void> => {
    if (auth.status !== "authenticated" || !accountOwnerRef.current) {
      throw new Error("기기 설정 목록을 동기화하려면 먼저 계정에 로그인해 주세요.");
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      const error = "오프라인 상태라 기기 설정 목록을 동기화하지 못했습니다.";
      inventorySyncErrorRef.current = error;
      setInventorySync({ status: "error", loading: false, error });
      throw new Error(error);
    }
    const generation = accountGenerationRef.current;
    const owner = accountOwnerRef.current;
    const revision = inventorySyncRevisionRef.current;
    const uploadEnabled = inventorySyncEnabledRef.current;
    inventorySyncCompletedRevisionRef.current = -1;
    await refreshDeviceInventory();
    await syncNowRef.current();
    if (generation !== accountGenerationRef.current || owner !== accountOwnerRef.current) {
      throw new Error("로그인 계정이 변경되어 기기 설정 목록 동기화를 중단했습니다.");
    }
    if (inventorySyncErrorRef.current) throw new Error(inventorySyncErrorRef.current);
    if (uploadEnabled && inventorySyncCompletedRevisionRef.current !== revision) {
      throw new Error("기기 설정 목록 동기화를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    }
  }, [auth.status, refreshDeviceInventory]);

  const setInventorySyncEnabled = useCallback(async (enabled: boolean) => {
    if (auth.status !== "authenticated" || !accountOwnerRef.current) {
      throw new Error("기기 설정 목록을 동기화하려면 먼저 계정에 로그인해 주세요.");
    }
    writeInventorySyncPreference(accountOwnerRef.current, enabled);
    setInventorySyncPreferenceSet(true);
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

  const saveProviderCredential = useCallback((provider: CredentialProvider, value: ProviderCredentials | Record<string, string>) => {
    credentialRevisionRef.current.invalidate(provider);
    return serializeSyncRef.current(() => runCredentialMutation(credentialRevisionRef.current, provider, async () => {
      if (!credentialOwner || credentialOwnerRef.current !== credentialOwner) throw new Error("로그인 계정이 변경되었습니다. 자격 증명을 다시 저장해 주세요.");
      const generation = accountGenerationRef.current;
      parseProviderCredentials(provider, JSON.stringify(value));
      const marker = await storeOwnedProviderSecret(provider, credentialOwner, JSON.stringify(value));
      if (generation !== accountGenerationRef.current || credentialOwnerRef.current !== credentialOwner) {
        await removeOwnedProviderSecretIfMarker(provider, credentialOwner, marker).catch(() => undefined);
        throw new Error("로그인 계정이 변경되어 자격 증명 저장을 취소했습니다.");
      }
      setProviderUsage((current) => current.filter((item) => item.provider !== provider));
      setProviderEvents((current) => current.filter((item) => item.provider !== provider));
      await refreshCredentialStatus();
    }));
  }, [credentialOwner, refreshCredentialStatus]);

  const removeProviderCredential = useCallback((provider: CredentialProvider) => {
    credentialRevisionRef.current.invalidate(provider);
    return serializeSyncRef.current(() => runCredentialMutation(credentialRevisionRef.current, provider, async () => {
      if (!credentialOwner || credentialOwnerRef.current !== credentialOwner) throw new Error("로그인 계정이 변경되었습니다. 자격 증명 상태를 다시 확인해 주세요.");
      const generation = accountGenerationRef.current;
      await removeOwnedProviderSecret(provider, credentialOwner);
      if (generation !== accountGenerationRef.current || credentialOwnerRef.current !== credentialOwner) return;
      setProviderUsage((current) => current.filter((item) => item.provider !== provider));
      setProviderEvents((current) => current.filter((item) => item.provider !== provider));
      await refreshCredentialStatus();
    }));
  }, [credentialOwner, refreshCredentialStatus]);

  const refreshProviderUsage = useCallback(async (provider: CredentialProvider, query: UsageQuery = defaultQuery()) => {
    if (!enabledProviders.includes(USAGE_PROVIDER_BY_CREDENTIAL[provider])) {
      throw new Error("설정에서 해당 AI 서비스의 수집을 먼저 활성화해 주세요.");
    }
    const generation = accountGenerationRef.current;
    const credentialRevision = credentialRevisionRef.current.current(provider);
    const owner = auth.status === "authenticated" ? accountOwner(sessionScope(client.config), client.currentSession) : undefined;
    if (!credentialOwner || credentialOwnerRef.current !== credentialOwner) throw new Error("로그인 계정이 변경되었습니다. 자격 증명 상태를 다시 확인해 주세요.");
    const records = await fetchStoredProviderUsage(provider, credentialOwner, query);
    if (generation !== accountGenerationRef.current
      || credentialOwnerRef.current !== credentialOwner
      || !credentialRevisionRef.current.matches(provider, credentialRevision)
      || owner !== (auth.status === "authenticated" ? accountOwnerRef.current : undefined)
      || providerKey !== currentProviderKey.current) return [];
    const converted = providerRecordsToUsageEvents(records, getOrCreateDeviceId());
    providerEventsOwnerRef.current = owner;
    setProviderUsage((current) => [...current.filter((item) => item.provider !== provider), ...records]);
    setProviderEvents((current) => deduplicateSyncEvents([...current.filter((item) => item.provider !== provider), ...converted]));
    return converted;
  }, [auth.status, client, credentialOwner, enabledProviders, providerKey]);

  const refreshProviderUsageForUi = useCallback(async (provider: CredentialProvider, query?: UsageQuery): Promise<void> => {
    await refreshProviderUsage(provider, query);
  }, [refreshProviderUsage]);

  const updateSessionTitle = useCallback(async (sessionId: string, title: string) => {
    const next = { ...sessionTitlesRef.current };
    const normalized = title.trim();
    if (normalized) next[sessionId] = normalized;
    else delete next[sessionId];
    sessionTitlesRef.current = next;
    setSessionTitles(next);
    writeSessionTitles(auth.status === "authenticated" ? accountOwnerRef.current : undefined, next);
  }, [auth.status]);

  const updateProjectName = useCallback(async (projectId: string, name: string) => {
    const normalized = sanitizeProjectName(name);
    if (!normalized) throw new Error("프로젝트 이름은 1자 이상 80자 이하로 입력해 주세요.");
    if (auth.status !== "authenticated") {
      await local.updateProjectName(projectId, normalized);
      return;
    }
    const generation = accountGenerationRef.current;
    const owner = accountOwnerRef.current;
    if (!owner || generation !== accountGenerationRef.current) {
      throw new Error("로그인 계정이 변경되어 프로젝트 이름 동기화를 중단했습니다.");
    }
    const nextOverrides = { ...accountProjectNameOverrides, [projectId]: normalized };
    writeAccountProjectNameOverrides(owner, nextOverrides);
    setAccountProjectNameOverrides(nextOverrides);
    setRemoteProjectNames((current) => ({ ...current, [projectId]: normalized }));
    if (generation !== accountGenerationRef.current || owner !== accountOwnerRef.current) {
      throw new Error("로그인 계정이 변경되어 프로젝트 이름 동기화를 중단했습니다.");
    }
    const result = await syncService.updateProjectName(projectId, normalized);
    if (generation !== accountGenerationRef.current || owner !== accountOwnerRef.current) return;
    if (result.error) {
      setCloudSync((current) => ({ ...current, status: "error", error: `프로젝트 이름 동기화 실패. ${result.error}` }));
      throw new Error(result.error);
    }
  }, [accountProjectNameOverrides, auth.status, local.updateProjectName, syncService]);

  const configureSupabase = useCallback(async (url: string, publishableKey: string) => {
    if (!import.meta.env.DEV) throw new Error("Supabase 서버 변경은 개발 모드에서만 가능합니다.");
    const normalizedUrl = url.trim().replace(/\/+$/, "");
    const normalizedKey = publishableKey.trim();
    if (!isSecureSupabaseUrl(normalizedUrl) || !isSupabasePublicKey(normalizedKey)) throw new Error("HTTPS Supabase URL과 publishable key가 필요합니다. secret 또는 service_role key는 저장할 수 없습니다.");
    const boundaryOwner = accountOwnerRef.current;
    const boundaryGeneration = accountGenerationRef.current;
    if (!await flushLocalUsageAccountBoundary(boundaryOwner, undefined, local.refreshAfterPending)) {
      throw new Error("현재 계정의 로컬 사용량을 안전하게 저장하지 못해 서버 변경을 중단했습니다.");
    }
    if (boundaryGeneration !== accountGenerationRef.current || boundaryOwner !== accountOwnerRef.current) {
      throw new Error("로그인 계정이 변경되어 서버 변경을 중단했습니다.");
    }
    const config = { url: normalizedUrl, anonKey: normalizedKey };
    const cleanupErrors: string[] = [];
    try { markSessionTombstone(sessionScope(client.config)); } catch (cause) { cleanupErrors.push(`로그아웃 표시 저장 실패: ${message(cause)}`); }
    const generation = ++accountGenerationRef.current;
    authService.signOutLocally();
    accountOwnerRef.current = undefined;
    localOwnershipOwnerHashRef.current = undefined;
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
    setRemoteProjectNames({});
    setAccountProjectNameOverrides({});
    setDevices([currentDevice(currentDeviceInfoRef.current)]);
    setSessionTitles(readSessionTitles(undefined));
    setAuth({ enabled: true, status: "signed_out", error: cleanupErrors.length ? cleanupErrors.join(" ") : undefined });
    setCloudSync({ status: "signed_out", uploaded: 0, pending: 0 });
    const credentialCleanup = await Promise.allSettled([
      removeProviderSecret("supabase"),
      removeProviderSecret(PENDING_SESSION_CREDENTIAL),
    ]);
    if (credentialCleanup[0].status === "rejected") cleanupErrors.push(`저장된 세션 삭제 실패: ${message(credentialCleanup[0].reason)}`);
    if (credentialCleanup[1].status === "rejected") cleanupErrors.push(`전환 대기 세션 삭제 실패: ${message(credentialCleanup[1].reason)}`);
    if (cleanupErrors.length && generation === accountGenerationRef.current) {
      setAuth({ enabled: true, status: "signed_out", error: cleanupErrors.join(" ") });
    }
  }, [authService, clearAccountInventoryState, clearAccountProviderState, client.config, local.refreshAfterPending]);

  const clearSupabaseConfig = useCallback(async () => {
    if (!import.meta.env.DEV) throw new Error("Supabase 서버 변경은 개발 모드에서만 가능합니다.");
    const boundaryOwner = accountOwnerRef.current;
    const boundaryGeneration = accountGenerationRef.current;
    if (!await flushLocalUsageAccountBoundary(boundaryOwner, undefined, local.refreshAfterPending)) {
      throw new Error("현재 계정의 로컬 사용량을 안전하게 저장하지 못해 서버 초기화를 중단했습니다.");
    }
    if (boundaryGeneration !== accountGenerationRef.current || boundaryOwner !== accountOwnerRef.current) {
      throw new Error("로그인 계정이 변경되어 서버 초기화를 중단했습니다.");
    }
    const cleanupErrors: string[] = [];
    try { markSessionTombstone(sessionScope(client.config)); } catch (cause) { cleanupErrors.push(`로그아웃 표시 저장 실패: ${message(cause)}`); }
    const generation = ++accountGenerationRef.current;
    authService.signOutLocally();
    accountOwnerRef.current = undefined;
    localOwnershipOwnerHashRef.current = undefined;
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
    setRemoteProjectNames({});
    setAccountProjectNameOverrides({});
    setDevices([currentDevice(currentDeviceInfoRef.current)]);
    setSessionTitles(readSessionTitles(undefined));
    setAuth({ enabled: Boolean(defaultConfig), status: defaultConfig ? "signed_out" : "local", error: cleanupErrors.length ? cleanupErrors.join(" ") : undefined });
    setCloudSync({ status: defaultConfig ? "signed_out" : "disabled", uploaded: 0, pending: 0 });
    const credentialCleanup = await Promise.allSettled([
      removeProviderSecret("supabase"),
      removeProviderSecret(PENDING_SESSION_CREDENTIAL),
    ]);
    if (credentialCleanup[0].status === "rejected") cleanupErrors.push(`저장된 세션 삭제 실패: ${message(credentialCleanup[0].reason)}`);
    if (credentialCleanup[1].status === "rejected") cleanupErrors.push(`전환 대기 세션 삭제 실패: ${message(credentialCleanup[1].reason)}`);
    if (cleanupErrors.length && generation === accountGenerationRef.current) {
      setAuth({ enabled: Boolean(defaultConfig), status: defaultConfig ? "signed_out" : "local", error: cleanupErrors.join(" ") });
    }
  }, [authService, clearAccountInventoryState, clearAccountProviderState, client.config, local.refreshAfterPending]);

  const usageViews = useMemo(() => {
    const activeOwner = auth.status === "authenticated" ? accountOwnerRef.current : undefined;
    const localOwnerHash = auth.status === "authenticated"
      ? localUsageOwnerHash(
        client.config?.url,
        client.currentSession?.userId ?? auth.userId ?? (client.currentSession?.accessToken ? jwtSubject(client.currentSession.accessToken) : undefined),
      )
      : undefined;
    const visibleLocalEvents = auth.status === "authenticated"
      ? localOwnerHash && localOwnershipRef.current
        ? filterAccountLocalEvents(local.events, localOwnershipRef.current, localOwnerHash)
        : []
      : local.events;
    const currentProviderEvents = providerEventsForOwner(providerEvents, providerEventsOwnerRef.current, activeOwner).flatMap(toLocalUsageEvent);
    const cloudEvents = [...remoteEvents, ...currentProviderEvents]
      .filter((event) => enabledProviders.includes(event.provider));
    return buildUsageViews(visibleLocalEvents, cloudEvents);
  }, [auth.status, auth.userId, client, enabledProviders, local.events, localOwnershipRevision, providerEvents, providerKey, remoteEvents]);
  const accountProviderUsage = useMemo(
    () => mergeAccountProviderUsage(
      remoteAccountEvents.filter((event) => syncEventProviderEnabled(event, enabledProviders)),
      providerUsage.filter((record) => selectedCredentialProviders.includes(record.provider)),
    ),
    [enabledProviders, providerKey, providerUsage, remoteAccountEvents, selectedCredentialProviders],
  );
  const authenticatedProjectNames = useMemo(
    () => mergeAccountProjectNames(local.inferredProjectNames, remoteProjectNames, accountProjectNameOverrides),
    [accountProjectNameOverrides, local.inferredProjectNames, remoteProjectNames],
  );
  const projectNames = auth.status === "authenticated" ? authenticatedProjectNames : local.projectNames;
  const projectNameOverrides = auth.status === "authenticated" ? accountProjectNameOverrides : local.projectNameOverrides;

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
    inventorySyncPreferenceSet,
    inventorySync,
    projectNames,
    projectNameOverrides,
    remoteProjectNames,
    sessionTitles,
    sendMagicLink,
    signInWithGoogle,
    cancelPendingAuth,
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
    updateProjectName,
    configureSupabase,
    clearSupabaseConfig,
  };
}

function emptyCredentialStatus(): Record<CredentialProvider, CredentialStatus> {
  return { openai: { configured: false, checking: false }, anthropic: { configured: false, checking: false }, google: { configured: false, checking: false } };
}
function fallbackCurrentDeviceInfo(): CurrentDeviceInfo {
  const deviceId = getOrCreateDeviceId();
  return { name: fallbackDeviceName(deviceId), platform: "windows" };
}

function currentDevice(info: CurrentDeviceInfo = fallbackCurrentDeviceInfo()): DeviceRegistration {
  return {
    id: getOrCreateDeviceId(),
    name: info.name,
    platform: info.platform,
    appVersion: "0.5.4",
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
  stage: (session: SupabaseSession, scope: string) => Promise<string>;
  discardPending: (marker: string) => Promise<void>;
  promote: (marker: string, scope: string) => Promise<void>;
  discardPromoted: (marker: string) => Promise<void>;
  beforeAccept?: () => Promise<boolean>;
  accept: (session: SupabaseSession) => void;
}

export async function commitSession(
  session: SupabaseSession,
  generation: number,
  scope: string | undefined,
  controls: SessionCommitControls,
): Promise<boolean> {
  if (!scope || generation !== controls.currentGeneration() || scope !== controls.currentScope()) return false;
  const marker = await controls.stage(session, scope);
  if (generation !== controls.currentGeneration() || scope !== controls.currentScope()) {
    await controls.discardPending(marker);
    return false;
  }
  if (controls.beforeAccept) {
    try {
      if (!await controls.beforeAccept()) {
        await controls.discardPending(marker);
        return false;
      }
    } catch (cause) {
      await controls.discardPending(marker);
      throw cause;
    }
  }
  if (generation !== controls.currentGeneration() || scope !== controls.currentScope()) {
    await controls.discardPending(marker);
    return false;
  }
  try {
    await controls.promote(marker, scope);
  } catch (cause) {
    await controls.discardPending(marker);
    throw cause;
  }
  if (generation !== controls.currentGeneration() || scope !== controls.currentScope()) {
    await controls.discardPromoted(marker);
    await controls.discardPending(marker);
    return false;
  }
  controls.accept(session);
  return true;
}

interface StoredSupabaseSession {
  scope: string;
  session: SupabaseSession;
  marker: string;
}

async function stageSession(session: SupabaseSession, scope: string): Promise<string> {
  await clearStalePendingSession().catch(() => undefined);
  const marker = crypto.randomUUID();
  try {
    await storeProviderSecret(PENDING_SESSION_CREDENTIAL, JSON.stringify({
      scope,
      session: compactSessionForStorage(session),
      marker,
    } satisfies StoredSupabaseSession));
  } catch (cause) {
    await removeProviderSecretIfMarker(PENDING_SESSION_CREDENTIAL, marker).catch(() => undefined);
    throw cause;
  }
  try { window.localStorage.removeItem(SESSION_KEY); } catch { /* 레거시 저장소 오류가 활성 세션을 바꾸지는 않습니다. */ }
  return marker;
}

async function promotePendingSession(marker: string, scope: string): Promise<void> {
  const staged = await loadProviderSecret(PENDING_SESSION_CREDENTIAL);
  if (!staged) throw new Error("전환 대기 중인 Supabase 세션을 찾을 수 없습니다.");
  let parsed: Partial<StoredSupabaseSession> | null;
  try {
    parsed = JSON.parse(staged) as Partial<StoredSupabaseSession> | null;
  } catch {
    throw new Error("전환 대기 중인 Supabase 세션 형식이 올바르지 않습니다.");
  }
  if (!parsed || parsed.marker !== marker || parsed.scope !== scope || !parsed.session?.refreshToken) {
    throw new Error("전환 대기 중인 Supabase 세션이 현재 로그인 요청과 일치하지 않습니다.");
  }
  await storeProviderSecret("supabase", staged);
  await removeProviderSecretIfMarker(PENDING_SESSION_CREDENTIAL, marker).catch(() => undefined);
}

export function compactSessionForStorage(session: SupabaseSession): SupabaseSession {
  if (!session.refreshToken) throw new Error("Supabase 세션에 새로고침 토큰이 없어 안전하게 저장할 수 없습니다.");
  return { accessToken: "", refreshToken: session.refreshToken, userId: session.userId };
}

async function removePendingSessionIfMarker(marker: string): Promise<void> {
  await removeProviderSecretIfMarker(PENDING_SESSION_CREDENTIAL, marker);
}

async function removeActiveSessionIfMarker(marker: string): Promise<void> {
  await removeProviderSecretIfMarker("supabase", marker);
}

export async function clearStalePendingSession(
  remove: () => Promise<void> = () => removeProviderSecret(PENDING_SESSION_CREDENTIAL),
): Promise<void> {
  await remove();
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
      if (parsed.scope === scope && (parsed.session?.accessToken || parsed.session?.refreshToken)) return parsed.session;
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

export async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<PromiseSettledResult<T> | { status: "timed_out" }> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const settled: Promise<PromiseSettledResult<T>> = promise.then(
    (value): PromiseFulfilledResult<T> => ({ status: "fulfilled", value }),
    (reason: unknown): PromiseRejectedResult => ({ status: "rejected", reason }),
  );
  const result = await Promise.race([
    settled,
    new Promise<{ status: "timed_out" }>((resolve) => {
      timeoutId = setTimeout(() => {
        onTimeout?.();
        resolve({ status: "timed_out" });
      }, timeoutMs);
    }),
  ]);
  if (timeoutId !== undefined) clearTimeout(timeoutId);
  return result;
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
): boolean {
  let changed = fullReconcile;
  if (fullReconcile) {
    cache.fingerprints.clear();
    cache.remoteEvents.clear();
    cache.cursor = undefined;
    cache.lastFullAt = now;
  }
  for (const event of downloaded) {
    const fingerprint = usageEventFingerprint(event);
    if (cache.fingerprints.get(event.eventId) !== fingerprint || !cache.remoteEvents.has(event.eventId)) {
      cache.remoteEvents.set(event.eventId, event);
      changed = true;
    }
    cache.fingerprints.set(event.eventId, fingerprint);
    advanceUsageCursor(cache, event.createdAt);
  }
  cache.cursor ??= new Date(now - 5 * 60_000).toISOString();
  cache.initialized = true;
  return changed;
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
  allowOverride = false,
): SupabaseConfig | null {
  return allowOverride && saved && isSecureSupabaseUrl(saved.url) && isSupabasePublicKey(saved.anonKey) ? saved : buildDefault;
}

export function clearProductionSupabaseOverride(
  storage: Pick<Storage, "getItem" | "removeItem">,
  allowOverride: boolean,
): boolean {
  let hasStoredOverride: boolean;
  try { hasStoredOverride = storage.getItem(CONFIG_KEY) !== null; } catch { return false; }
  if (allowOverride || !hasStoredOverride) return true;
  for (const key of [SESSION_KEY, AUTH_STATE_KEY, AUTH_PKCE_VERIFIER_KEY, CONFIG_KEY]) {
    try { storage.removeItem(key); } catch { return false; }
  }
  return true;
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

export function localUsageOwnerHash(url: string | undefined, userId: string | undefined): string | undefined {
  if (!url || !userId || userId.length > 256 || userId.trim() !== userId || /[\u0000-\u001f]/.test(userId)) return undefined;
  try {
    const parsed = new URL(url);
    if (!isSecureSupabaseUrl(parsed.toString())) return undefined;
    const normalizedPath = parsed.pathname.replace(/\/+$/, "");
    return stableId(`${parsed.origin.toLowerCase()}${normalizedPath}`, userId);
  } catch {
    return undefined;
  }
}

export function selectLocalUsagePersistenceSnapshot(
  collectionSnapshot: boolean,
  suppliedEvents: LocalUsageEvent[],
  suppliedCodexCumulative: Record<string, TokenBreakdown>,
  suppliedCodexRetiredSessionFilter: string,
  latestEvents: LocalUsageEvent[],
  latestCodexCumulative: Record<string, TokenBreakdown>,
  latestCodexRetiredSessionFilter: string,
): {
  events: LocalUsageEvent[];
  codexCumulative: Record<string, TokenBreakdown>;
  codexRetiredSessionFilter: string;
} {
  return collectionSnapshot
    ? {
        events: suppliedEvents,
        codexCumulative: suppliedCodexCumulative,
        codexRetiredSessionFilter: suppliedCodexRetiredSessionFilter,
      }
    : {
        events: latestEvents,
        codexCumulative: latestCodexCumulative,
        codexRetiredSessionFilter: latestCodexRetiredSessionFilter,
      };
}

export function selectRetainedLocalUsageClaimEvents(
  events: LocalUsageEvent[],
  retainedEvents: LocalUsageEvent[],
): LocalUsageEvent[] {
  const retainedIds = new Set(retainedEvents.map((event) => localUsageOwnershipKey(event)));
  return events.filter((event) => retainedIds.has(localUsageOwnershipKey(event)));
}

export async function flushLocalUsageAccountBoundary(
  currentOwner: string | undefined,
  nextOwner: string | undefined,
  refresh: () => Promise<boolean>,
): Promise<boolean> {
  if (!currentOwner || currentOwner === nextOwner) return true;
  return refresh();
}

function legacyLocalUsageOwnerHash(value: string): string | undefined {
  const parts = value.split("\n");
  if (parts.length !== 3 || !parts[1]) return undefined;
  return localUsageOwnerHash(parts[0], parts[2]);
}

function readLegacyLocalUsageOwnership(storage: Storage): Record<string, string> {
  const parsed = readJsonFromStorage<unknown>(storage, LOCAL_OWNERSHIP_KEY, {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).flatMap(([eventId, owner]) => (
    eventId && typeof owner === "string" ? [[eventId, owner]] : []
  )));
}

export function migrateLocalUsageOwnership(
  events: LocalUsageEvent[],
  legacyOwnership: Record<string, string>,
): LocalUsageOwnershipState {
  const knownEventIds = [...new Set(events.map((event) => localUsageOwnershipKey(event)))];
  const known = new Set(knownEventIds);
  const owners = Object.fromEntries(Object.entries(legacyOwnership).flatMap(([eventId, owner]) => {
    const ownerHash = known.has(eventId) ? legacyLocalUsageOwnerHash(owner) : undefined;
    return ownerHash ? [[eventId, ownerHash]] : [];
  }));
  return { version: 1, knownEventIds, owners, seenFilter: "" };
}

function decodeLocalUsageSeenFilter(encoded = ""): Uint8Array {
  if (!encoded) return new Uint8Array(LOCAL_USAGE_SEEN_FILTER_BYTES);
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new Error("로컬 사용량 재등장 필터가 손상되었습니다.");
  }
  if (binary.length !== LOCAL_USAGE_SEEN_FILTER_BYTES) {
    throw new Error("로컬 사용량 재등장 필터 크기가 올바르지 않습니다.");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeLocalUsageSeenFilter(filter: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < filter.length; offset += 32_768) {
    chunks.push(String.fromCharCode(...filter.subarray(offset, offset + 32_768)));
  }
  return btoa(chunks.join(""));
}

function localUsageSeenFilterIndexes(eventId: string): number[] {
  const hash = stableId(eventId);
  const bitLength = LOCAL_USAGE_SEEN_FILTER_BYTES * 8;
  return Array.from({ length: LOCAL_USAGE_SEEN_FILTER_HASHES }, (_, index) => (
    Number.parseInt(hash.slice(index * 8, index * 8 + 8), 16) % bitLength
  ));
}

function localUsageSeenFilterHas(filter: Uint8Array, eventId: string): boolean {
  return localUsageSeenFilterIndexes(eventId).every((bit) => (
    (filter[Math.floor(bit / 8)] & (1 << (bit % 8))) !== 0
  ));
}

function addLocalUsageSeenFilterIds(encoded: string | undefined, eventIds: string[]): string {
  if (!eventIds.length) return encoded ?? "";
  const filter = decodeLocalUsageSeenFilter(encoded);
  for (const eventId of eventIds) {
    for (const bit of localUsageSeenFilterIndexes(eventId)) {
      filter[Math.floor(bit / 8)] |= 1 << (bit % 8);
    }
  }
  return encodeLocalUsageSeenFilter(filter);
}

export function pruneLocalUsageOwnership(
  ownership: LocalUsageOwnershipState,
  events: LocalUsageEvent[],
): LocalUsageOwnershipState {
  const retained = new Set(events.map((event) => localUsageOwnershipKey(event)));
  const removedEventIds = ownership.knownEventIds.filter((eventId) => !retained.has(eventId));
  const knownEventIds = ownership.knownEventIds.filter((eventId) => retained.has(eventId));
  const known = new Set(knownEventIds);
  const owners = Object.fromEntries(
    Object.entries(ownership.owners).filter(([eventId]) => known.has(eventId)),
  );
  const unchanged = removedEventIds.length === 0
    && Object.keys(owners).length === Object.keys(ownership.owners).length;
  return unchanged ? ownership : {
    version: 1,
    knownEventIds,
    owners,
    seenFilter: addLocalUsageSeenFilterIds(ownership.seenFilter, removedEventIds),
  };
}

export function sealLocalUsageOwnershipBaseline(
  ownership: LocalUsageOwnershipState,
  events: LocalUsageEvent[],
): LocalUsageOwnershipState {
  const pruned = pruneLocalUsageOwnership(ownership, events);
  const known = new Set(pruned.knownEventIds);
  const missing = events
    .map((event) => localUsageOwnershipKey(event))
    .filter((eventId) => !known.has(eventId));
  if (!missing.length) return pruned;
  return {
    version: 1,
    knownEventIds: [...pruned.knownEventIds, ...new Set(missing)],
    owners: pruned.owners,
    seenFilter: pruned.seenFilter,
  };
}

export function claimAccountLocalEvents(
  ownership: LocalUsageOwnershipState,
  events: LocalUsageEvent[],
  ownerHash: string,
): { events: LocalUsageEvent[]; ownership: LocalUsageOwnershipState } {
  const known = new Set(ownership.knownEventIds);
  let knownEventIds = ownership.knownEventIds;
  let owners = ownership.owners;
  const seenFilter = ownership.seenFilter ? decodeLocalUsageSeenFilter(ownership.seenFilter) : undefined;
  const owned: LocalUsageEvent[] = [];
  for (const event of events) {
    const key = localUsageOwnershipKey(event);
    const currentOwner = owners[key];
    if (!known.has(key) && seenFilter && localUsageSeenFilterHas(seenFilter, key)) {
      if (knownEventIds === ownership.knownEventIds) knownEventIds = [...knownEventIds];
      known.add(key);
      knownEventIds.push(key);
    } else if (!known.has(key)) {
      if (knownEventIds === ownership.knownEventIds) knownEventIds = [...knownEventIds];
      if (owners === ownership.owners) owners = { ...owners };
      known.add(key);
      knownEventIds.push(key);
      owners[key] = ownerHash;
      owned.push(event);
    } else if (currentOwner === ownerHash) {
      owned.push(event);
    }
  }
  const next = knownEventIds === ownership.knownEventIds
    ? ownership
    : { version: 1 as const, knownEventIds, owners, seenFilter: ownership.seenFilter };
  return { events: owned, ownership: next };
}

export function filterAccountLocalEvents(
  events: LocalUsageEvent[],
  ownership: LocalUsageOwnershipState,
  ownerHash: string,
): LocalUsageEvent[] {
  return events.filter((event) => ownership.owners[localUsageOwnershipKey(event)] === ownerHash);
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

export function hasInventorySyncPreference(owner?: string, storage: Storage = window.localStorage): boolean {
  return Boolean(owner) && storage.getItem(inventoryPreferenceKey(owner)) !== null;
}

export function writeInventorySyncPreference(owner: string, enabled: boolean, storage: Storage = window.localStorage): void {
  storage.setItem(inventoryPreferenceKey(owner), String(enabled));
}

function inventoryPreferenceKey(owner?: string): string {
  return `${INVENTORY_SYNC_KEY}:${stableId(owner)}`;
}

export function markInventoryLoginConsent(storage: Storage = window.sessionStorage): void {
  storage.setItem(INVENTORY_SYNC_LOGIN_CONSENT_KEY, "true");
}

export function consumeInventoryLoginConsent(storage: Storage = window.sessionStorage): boolean {
  const consented = storage.getItem(INVENTORY_SYNC_LOGIN_CONSENT_KEY) === "true";
  storage.removeItem(INVENTORY_SYNC_LOGIN_CONSENT_KEY);
  return consented;
}

export function clearInventoryLoginConsent(storage: Storage = window.sessionStorage): void {
  storage.removeItem(INVENTORY_SYNC_LOGIN_CONSENT_KEY);
}

export function cancelPendingAuthAttempt(
  authAttemptGeneration: { current: number },
  accountGeneration: { current: number },
  authStorage: Storage = window.localStorage,
  consentStorage: Storage = window.sessionStorage,
): void {
  authAttemptGeneration.current += 1;
  accountGeneration.current += 1;
  authStorage.removeItem(AUTH_STATE_KEY);
  authStorage.removeItem(AUTH_PKCE_VERIFIER_KEY);
  clearInventoryLoginConsent(consentStorage);
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

export function mergeAccountProjectNames(
  inferred: Readonly<Record<string, string>>,
  remote: Readonly<Record<string, string>>,
  overrides: Readonly<Record<string, string>>,
): Record<string, string> {
  return { ...inferred, ...remote, ...overrides };
}

export function readAccountProjectNameOverrides(
  owner: string | undefined,
  storage: Storage = window.localStorage,
): Record<string, string> {
  if (!owner) return {};
  const byOwner = readJsonFromStorage<Record<string, unknown>>(storage, PROJECT_NAMES_BY_OWNER_KEY, {});
  return sanitizeProjectNameMap(byOwner[owner]);
}

export function writeAccountProjectNameOverrides(
  owner: string,
  names: Readonly<Record<string, string>>,
  storage: Storage = window.localStorage,
): void {
  if (!owner) return;
  const byOwner = readJsonFromStorage<Record<string, unknown>>(storage, PROJECT_NAMES_BY_OWNER_KEY, {});
  storage.setItem(PROJECT_NAMES_BY_OWNER_KEY, JSON.stringify({
    ...byOwner,
    [owner]: sanitizeProjectNameMap(names),
  }));
}

function sanitizeProjectNameMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([projectId, name]) => {
    const normalized = sanitizeProjectName(typeof name === "string" ? name : "");
    return projectId && normalized ? [[projectId, normalized]] : [];
  }));
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
function syncEventProviderEnabled(event: SyncUsageEvent, enabledProviders: Provider[]): boolean {
  const provider = USAGE_PROVIDER_BY_SYNC[event.provider];
  return Boolean(provider && enabledProviders.includes(provider));
}
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
  const provider = USAGE_PROVIDER_BY_SYNC[event.provider];
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
