// Supabase 인증 콜백 딥링크를 Tauri 런타임에서 안전하게 수신하는 어댑터
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";

export const AUTH_REDIRECT_URL = "token-deck://auth";

export type AuthDeepLinkHandler = (url: URL) => void | Promise<void>;

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
