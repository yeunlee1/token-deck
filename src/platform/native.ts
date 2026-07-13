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

export type QuotaProvider = "codex" | "claude" | "gemini";
const ALL_QUOTA_PROVIDERS: QuotaProvider[] = ["codex", "claude", "gemini"];

export interface QuotaWindowStatus {
  usedPercent: number;
  remainingPercent: number;
  windowMinutes: number;
  resetsAt: number | null;
}

export interface ProviderQuotaStatus {
  provider: QuotaProvider;
  supported: boolean;
  planType: string | null;
  fiveHour: QuotaWindowStatus | null;
  weekly: QuotaWindowStatus | null;
  daily: QuotaWindowStatus | null;
  expiredWindows?: Array<"fiveHour" | "weekly" | "daily">;
  message: string | null;
  updatedAt: number | null;
}

export interface ClaudeQuotaCaptureStatus {
  configured: boolean;
  settingsPath: string;
  dataPath: string;
  hasData: boolean;
  existingStatusLine: boolean;
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

export function unsupportedQuotaStatuses(providers: QuotaProvider[] = ALL_QUOTA_PROVIDERS): ProviderQuotaStatus[] {
  return providers.map((provider) => ({
    provider,
    supported: false,
    planType: null,
    fiveHour: null,
    weekly: null,
    daily: null,
    message: "한도 상태는 데스크톱 앱에서 확인할 수 있습니다.",
    updatedAt: null,
  }));
}

export async function getQuotaStatuses(providers: QuotaProvider[] = ALL_QUOTA_PROVIDERS): Promise<ProviderQuotaStatus[]> {
  if (!isTauriRuntime()) return unsupportedQuotaStatuses(providers);
  return invoke<ProviderQuotaStatus[]>("quota_statuses", { providers });
}

export async function getClaudeQuotaCaptureStatus(): Promise<ClaudeQuotaCaptureStatus> {
  if (!isTauriRuntime()) return { configured: false, settingsPath: "", dataPath: "", hasData: false, existingStatusLine: false };
  return invoke<ClaudeQuotaCaptureStatus>("claude_quota_capture_status");
}

export async function configureClaudeQuotaCapture(): Promise<ClaudeQuotaCaptureStatus> {
  if (!isTauriRuntime()) throw new Error("Claude 한도 수집 설정은 데스크톱 앱에서만 변경할 수 있습니다.");
  return invoke<ClaudeQuotaCaptureStatus>("configure_claude_quota_capture");
}
