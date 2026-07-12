// Supabase 인증 콜백 딥링크를 Tauri 런타임에서 안전하게 수신하는 어댑터
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";

export const AUTH_REDIRECT_URL = "token-deck://auth";
export const AUTH_STATE_KEY = "token-deck-auth-state";
export const AUTH_PKCE_VERIFIER_KEY = "token-deck-auth-pkce-verifier";

export type AuthDeepLinkHandler = (url: URL) => void | Promise<void>;

export function authRedirectWithState(state: string, redirectTo = AUTH_REDIRECT_URL): string {
  const url = new URL(redirectTo);
  url.searchParams.set("state", state);
  return url.toString();
}

export function verifyAuthRedirectState(url: string, expectedState: string | null): void {
  const actualState = new URL(url).searchParams.get("state");
  if (!expectedState || !actualState || actualState !== expectedState) {
    throw new Error("요청하지 않은 로그인 콜백을 차단했습니다.");
  }
}

export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  if (!globalThis.crypto?.getRandomValues || !globalThis.crypto?.subtle) {
    throw new Error("이 환경에서는 안전한 Google 로그인을 시작할 수 없습니다.");
  }
  const verifier = toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: await createPkceChallenge(verifier) };
}

export async function createPkceChallenge(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

export function authRedirectCode(url: string): string | null {
  const parsed = new URL(url);
  const values = callbackValues(parsed);
  const error = values.get("error");
  if (error) {
    const description = values.get("error_description")?.trim();
    throw new Error(description ? `Google 로그인을 완료하지 못했습니다. ${description}` : `Google 로그인을 완료하지 못했습니다. (${error})`);
  }
  return values.get("code");
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function parseAuthUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "token-deck:" && url.hostname === "auth" ? url : null;
  } catch {
    return null;
  }
}

async function deliverAuthUrls(urls: string[] | null, handler: AuthDeepLinkHandler): Promise<void> {
  for (const value of urls ?? []) {
    const url = parseAuthUrl(value);
    if (url) await handler(url);
  }
}

function callbackValues(url: URL): URLSearchParams {
  const values = new URLSearchParams(url.hash.replace(/^#/, ""));
  for (const [key, value] of url.searchParams) values.set(key, value);
  return values;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function getCurrentAuthDeepLinks(): Promise<URL[]> {
  if (!isTauriRuntime()) return [];
  const urls = await getCurrent();
  return (urls ?? []).flatMap((value) => {
    const url = parseAuthUrl(value);
    return url ? [url] : [];
  });
}

export async function listenForAuthDeepLinks(handler: AuthDeepLinkHandler): Promise<() => void> {
  if (!isTauriRuntime()) return () => undefined;
  await deliverAuthUrls(await getCurrent(), handler);
  return onOpenUrl((urls) => {
    void deliverAuthUrls(urls, handler);
  });
}
