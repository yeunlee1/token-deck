// 공급사 자격 증명을 Windows Credential Manager에 보관하는 Tauri 서비스
import { invoke } from "@tauri-apps/api/core";

export type CredentialProvider = "openai" | "anthropic" | "google";

function ensureDesktop(): void {
  if (!("__TAURI_INTERNALS__" in window)) throw new Error("자격 증명 저장소는 데스크톱 앱에서만 사용할 수 있습니다.");
}

export async function storeProviderSecret(provider: CredentialProvider, secret: string): Promise<void> {
  ensureDesktop();
  await invoke("store_provider_secret", { provider, secret });
}

export async function loadProviderSecret(provider: CredentialProvider): Promise<string | undefined> {
  ensureDesktop();
  return (await invoke<string | null>("load_provider_secret", { provider })) ?? undefined;
}

export async function removeProviderSecret(provider: CredentialProvider): Promise<void> {
  ensureDesktop();
  await invoke("remove_provider_secret", { provider });
}
