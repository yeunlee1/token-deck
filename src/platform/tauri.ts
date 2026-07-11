// Tauri 백엔드의 로컬 로그 탐색 명령을 안전하게 호출하는 어댑터
import { invoke } from "@tauri-apps/api/core";

export interface LocalLogDocument {
  provider: "codex" | "claude" | "gemini";
  path: string;
  modifiedAt: number;
  content: string;
  gitRemote?: string;
}

export interface IntegrationStatus {
  codex: boolean;
  claude: boolean;
  gemini: boolean;
}

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export async function scanLocalUsage(modifiedSince?: number): Promise<LocalLogDocument[]> {
  if (!isTauriRuntime()) return [];
  return invoke<LocalLogDocument[]>("scan_local_usage", { modifiedSince });
}

export async function getIntegrationStatus(): Promise<IntegrationStatus> {
  if (!isTauriRuntime()) return { codex: true, claude: true, gemini: false };
  return invoke<IntegrationStatus>("integration_status");
}
