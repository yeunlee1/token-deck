// Tauri 백엔드의 로컬 로그 탐색 명령을 안전하게 호출하는 어댑터
import { invoke } from "@tauri-apps/api/core";

export interface LocalLogDocument {
  provider: "codex" | "claude" | "gemini";
  path: string;
  modifiedAt: number;
  content: string;
  gitRemote?: string;
  projectId?: string;
  projectName?: string;
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

interface NativeCurrentDeviceInfo {
  name: string | null;
  platform: string;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function scanLocalUsage(modifiedSince?: number): Promise<LocalLogDocument[]> {
  if (!isTauriRuntime()) return [];
  return invoke<LocalLogDocument[]>("scan_local_usage", { modifiedSince });
}

export async function getIntegrationStatus(): Promise<IntegrationStatus> {
  if (!isTauriRuntime()) return { codex: false, claude: false, gemini: false };
  return invoke<IntegrationStatus>("integration_status");
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
