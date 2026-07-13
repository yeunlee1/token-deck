// Tauri 백엔드의 로컬 로그 탐색 명령을 안전하게 호출하는 어댑터
import { invoke } from "@tauri-apps/api/core";
import type { ProjectNameMap, Provider, TokenBreakdown, UsageEvent } from "../core";

export interface LocalLogDocument {
  provider: "codex" | "claude" | "gemini";
  path: string;
  modifiedAt: number;
  content: string;
  gitRemote?: string;
  projectId?: string;
  projectName?: string;
}

export interface LocalUsageScanResult {
  documents: LocalLogDocument[];
  commitToken: string;
  codexBaselines?: string[];
}

export interface IntegrationStatus {
  codex: boolean;
  claude: boolean;
  gemini: boolean;
}

export interface CurrentDeviceInfo {
  name: string;
  platform: string;
}

export interface LocalUsageOwnershipState {
  version: 1;
  knownEventIds: string[];
  owners: Record<string, string>;
  seenFilter?: string;
}

export interface LocalUsageStateSnapshot {
  events: UsageEvent[];
  ownership: LocalUsageOwnershipState | null;
  codexCumulative: Record<string, TokenBreakdown>;
  codexRetiredSessionFilter: string;
}

interface NativeCurrentDeviceInfo {
  name: string | null;
  platform: string;
}

const DEVICE_ID_STORAGE_KEY = "token-deck-device-id";
const COLLECTION_PROVIDERS_STORAGE_KEY = "token-deck-collection-providers";
const USAGE_PROVIDERS: Provider[] = ["codex", "claude", "gemini"];

function isValidDeviceId(value: string | null): value is string {
  return value !== null
    && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function initializeDurableDeviceId(): Promise<string> {
  const existing = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY);
  const candidate = isValidDeviceId(existing) ? existing : crypto.randomUUID();
  const resolved = isTauriRuntime()
    ? await invoke<string>("load_or_store_device_id", { candidate })
    : candidate;
  if (!isValidDeviceId(resolved)) {
    throw new Error("네이티브 저장소에서 올바른 기기 식별자를 불러오지 못했습니다.");
  }
  window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, resolved);
  return resolved;
}

export async function restoreDurableCollectionProviders(): Promise<Provider[] | null> {
  if (!isTauriRuntime()) return null;
  const providers = await invoke<Provider[] | null>("load_collection_providers");
  if (providers === null) return null;
  const unique = [...new Set(providers)];
  if (
    unique.length === 0
    || unique.length !== providers.length
    || unique.some((provider) => !USAGE_PROVIDERS.includes(provider))
  ) {
    throw new Error("네이티브 저장소의 수집 서비스 설정이 올바르지 않습니다.");
  }
  window.localStorage.setItem(COLLECTION_PROVIDERS_STORAGE_KEY, JSON.stringify(unique));
  return unique;
}

export async function scanLocalUsage(
  providers: Provider[],
  modifiedSince?: number,
): Promise<LocalUsageScanResult> {
  if (!isTauriRuntime()) return { documents: [], commitToken: "", codexBaselines: [] };
  return invoke<LocalUsageScanResult>("scan_local_usage", { modifiedSince, providers });
}

export async function commitScanCursors(commitToken: string): Promise<boolean> {
  if (!isTauriRuntime()) return true;
  return invoke<boolean>("commit_scan_cursors", { commitToken });
}

export async function loadLocalUsageCache(): Promise<UsageEvent[]> {
  if (!isTauriRuntime()) return [];
  return invoke<UsageEvent[]>("load_local_usage_cache");
}

export async function saveLocalUsageCache(events: UsageEvent[]): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("save_local_usage_cache", { events });
}

export async function loadLocalUsageState(): Promise<LocalUsageStateSnapshot> {
  if (!isTauriRuntime()) {
    return { events: [], ownership: null, codexCumulative: {}, codexRetiredSessionFilter: "" };
  }
  return invoke<LocalUsageStateSnapshot>("load_local_usage_state");
}

export async function saveLocalUsageState(
  events: UsageEvent[],
  ownership: LocalUsageOwnershipState,
  codexCumulative: Record<string, TokenBreakdown>,
  codexRetiredSessionFilter: string,
): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("save_local_usage_state", {
    events,
    ownership,
    codexCumulative,
    codexRetiredSessionFilter,
  });
}

export async function loadLocalProjectNames(): Promise<ProjectNameMap> {
  if (!isTauriRuntime()) return {};
  return invoke<ProjectNameMap>("load_local_project_names");
}

export async function saveLocalProjectNames(names: ProjectNameMap): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("save_local_project_names", { names });
}

export async function getIntegrationStatus(providers: Provider[]): Promise<IntegrationStatus> {
  if (!isTauriRuntime()) return { codex: false, claude: false, gemini: false };
  return invoke<IntegrationStatus>("integration_status", { providers });
}

export async function setCollectionProviders(providers: Provider[]): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("set_collection_providers", { providers });
}

export function fallbackDeviceName(deviceId: string): string {
  const suffix = deviceId.replace(/[^A-Za-z0-9]/g, "").slice(-6).toUpperCase();
  return suffix ? `Windows 기기 ${suffix}` : "Windows 기기";
}

export async function getCurrentDeviceInfo(deviceId: string): Promise<CurrentDeviceInfo> {
  const fallback: CurrentDeviceInfo = { name: fallbackDeviceName(deviceId), platform: "windows" };
  if (!isTauriRuntime()) return fallback;

  try {
    const info = await invoke<NativeCurrentDeviceInfo>("current_device_info");
    return {
      name: info.name?.trim() || fallback.name,
      platform: info.platform.trim() || fallback.platform,
    };
  } catch {
    return fallback;
  }
}
