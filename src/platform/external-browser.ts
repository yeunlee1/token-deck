// 인증 주소를 운영체제의 기본 브라우저에서 안전하게 여는 어댑터
import { openUrl } from "@tauri-apps/plugin-opener";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function openExternalBrowser(value: string): Promise<void> {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("안전한 HTTPS 인증 주소만 열 수 있습니다.");
  }
  if (isTauriRuntime()) {
    await openUrl(url.toString());
    return;
  }
  const opened = window.open(url.toString(), "_blank", "noopener,noreferrer");
  if (!opened) throw new Error("브라우저에서 로그인 창을 열지 못했습니다.");
}
