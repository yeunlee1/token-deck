// 공급사 자격 증명을 Windows Credential Manager에 보관하는 Tauri 서비스
import { invoke } from "@tauri-apps/api/core";

export type CredentialProvider = "openai" | "anthropic" | "google";
export type CredentialKey = CredentialProvider | "supabase";

function ensureDesktop(): void {
  if (!("__TAURI_INTERNALS__" in window)) throw new Error("자격 증명 저장소는 데스크톱 앱에서만 사용할 수 있습니다.");
}

export async function storeProviderSecret(provider: CredentialKey, secret: string): Promise<void> {
  ensureDesktop();
  await invoke("store_provider_secret", { provider, secret });
}

export async function loadProviderSecret(provider: CredentialKey): Promise<string | undefined> {
  ensureDesktop();
  return (await invoke<string | null>("load_provider_secret", { provider })) ?? undefined;
}

export async function removeProviderSecret(provider: CredentialKey): Promise<void> {
  ensureDesktop();
  await invoke("remove_provider_secret", { provider });
}

export async function removeProviderSecretIfMarker(provider: CredentialKey, marker: string): Promise<boolean> {
  ensureDesktop();
  return invoke<boolean>("remove_provider_secret_if_marker", { provider, marker });
}
