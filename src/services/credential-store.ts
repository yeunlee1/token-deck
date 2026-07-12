// 공급사 자격 증명을 Windows Credential Manager에 보관하는 Tauri 서비스
import { invoke } from "@tauri-apps/api/core";
import { stableId } from "../core/parse-utils";

export type CredentialProvider = "openai" | "anthropic" | "google";
export type CredentialKey = CredentialProvider | "supabase" | `${CredentialProvider}:${string}`;

export interface OwnedProviderSecret {
  version: 1;
  owner: string;
  secret: string;
  marker: string;
}

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

export async function storeOwnedProviderSecret(provider: CredentialProvider, owner: string, secret: string): Promise<string> {
  const marker = crypto.randomUUID();
  await storeProviderSecret(ownedProviderKey(provider, owner), encodeOwnedProviderSecret(owner, secret, marker));
  return marker;
}

export async function loadOwnedProviderSecret(provider: CredentialProvider, owner: string): Promise<string | undefined> {
  const scoped = decodeOwnedProviderSecret(await loadProviderSecret(ownedProviderKey(provider, owner)), owner);
  if (scoped) return scoped.secret;
  const legacy = decodeOwnedProviderSecret(await loadProviderSecret(provider), owner);
  return legacy?.secret;
}

export async function removeOwnedProviderSecret(provider: CredentialProvider, owner: string): Promise<boolean> {
  const key = ownedProviderKey(provider, owner);
  const stored = decodeOwnedProviderSecret(await loadProviderSecret(key), owner);
  if (stored) return removeProviderSecretIfMarker(key, stored.marker);
  const legacy = decodeOwnedProviderSecret(await loadProviderSecret(provider), owner);
  return legacy ? removeProviderSecretIfMarker(provider, legacy.marker) : false;
}

export async function removeOwnedProviderSecretIfMarker(provider: CredentialProvider, owner: string, marker: string): Promise<boolean> {
  return removeProviderSecretIfMarker(ownedProviderKey(provider, owner), marker);
}

export function encodeOwnedProviderSecret(owner: string, secret: string, marker: string = crypto.randomUUID()): string {
  if (!owner.trim()) throw new Error("자격 증명 소유자 정보가 필요합니다.");
  if (!secret) throw new Error("저장할 자격 증명이 비어 있습니다.");
  return JSON.stringify({ version: 1, owner, secret, marker } satisfies OwnedProviderSecret);
}

export function decodeOwnedProviderSecret(value: string | undefined, expectedOwner: string): OwnedProviderSecret | undefined {
  if (!value || !expectedOwner) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<OwnedProviderSecret>;
    return parsed.version === 1
      && parsed.owner === expectedOwner
      && typeof parsed.secret === "string"
      && typeof parsed.marker === "string"
      ? parsed as OwnedProviderSecret
      : undefined;
  } catch {
    return undefined;
  }
}

export function ownedProviderKey(provider: CredentialProvider, owner: string): CredentialKey {
  if (!owner.trim()) throw new Error("자격 증명 소유자 정보가 필요합니다.");
  return `${provider}:${stableId("credential-owner", owner).slice(0, 16)}`;
}
