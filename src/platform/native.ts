// 자동 시작과 Gemini CLI 상태를 Tauri 네이티브 명령으로 조회하고 변경하는 어댑터
import { invoke } from "@tauri-apps/api/core";

export interface AutostartStatus {
  supported: boolean;
  enabled: boolean;
  launchCommand: string | null;
}

export interface GeminiStatus {
  installed: boolean;
  version: string | null;
  executablePath: string | null;
  settingsPath: string;
  settingsExists: boolean;
  telemetryConfigured: boolean;
  telemetryOutfile: string;
}

export interface GeminiConfigurationResult {
  settingsPath: string;
  backupPath: string | null;
  telemetryOutfile: string;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function getAutostartStatus(): Promise<AutostartStatus> {
  if (!isTauriRuntime()) return { supported: false, enabled: false, launchCommand: null };
  return invoke<AutostartStatus>("autostart_status");
}

export async function setAutostart(enabled: boolean): Promise<AutostartStatus> {
  if (!isTauriRuntime()) throw new Error("자동 시작 설정은 데스크톱 앱에서만 사용할 수 있습니다.");
  return invoke<AutostartStatus>("set_autostart", { enabled });
}

export async function getGeminiStatus(): Promise<GeminiStatus> {
  if (!isTauriRuntime()) {
    return {
      installed: false,
      version: null,
      executablePath: null,
      settingsPath: "",
      settingsExists: false,
      telemetryConfigured: false,
      telemetryOutfile: "",
    };
  }
  return invoke<GeminiStatus>("gemini_status");
}

export async function configureGeminiTelemetry(): Promise<GeminiConfigurationResult> {
  if (!isTauriRuntime()) throw new Error("Gemini 설정은 데스크톱 앱에서만 변경할 수 있습니다.");
  return invoke<GeminiConfigurationResult>("configure_gemini_telemetry");
}
