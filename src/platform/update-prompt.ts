// 숨김 또는 최소화된 메인 창을 업데이트 확인창보다 먼저 사용자에게 보여준다
import { getCurrentWindow } from "@tauri-apps/api/window";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function revealUpdatePrompt(): Promise<void> {
  if (!isTauriRuntime()) return;
  const appWindow = getCurrentWindow();
  await appWindow.show();
  await appWindow.unminimize();
  await appWindow.setFocus();
}
