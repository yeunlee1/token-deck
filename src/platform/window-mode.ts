// Token Deck 메인 창을 일반 대시보드와 오른쪽 아래 미니 패널 크기로 전환한다
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";

const MINI_WIDTH = 390;
const MINI_HEIGHT = 270;
const NORMAL_WIDTH = 1280;
const NORMAL_HEIGHT = 820;
const EDGE_GAP = 22;

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function applyWindowMode(mini: boolean): Promise<void> {
  if (!isTauriRuntime()) return;
  const appWindow = getCurrentWindow();
  const monitor = await currentMonitor();
  const width = mini ? MINI_WIDTH : NORMAL_WIDTH;
  const height = mini ? MINI_HEIGHT : NORMAL_HEIGHT;

  await appWindow.setMinSize(new LogicalSize(mini ? MINI_WIDTH : 920, mini ? MINI_HEIGHT : 640));
  await appWindow.setSize(new LogicalSize(width, height));
  await appWindow.setAlwaysOnTop(mini);

  if (!monitor) return;
  const scale = monitor.scaleFactor;
  const position = monitor.position.toLogical(scale);
  const size = monitor.size.toLogical(scale);
  const x = mini ? position.x + size.width - width - EDGE_GAP : position.x + Math.max(0, (size.width - width) / 2);
  const y = mini ? position.y + size.height - height - EDGE_GAP : position.y + Math.max(0, (size.height - height) / 2);
  await appWindow.setPosition(new LogicalPosition(Math.round(x), Math.round(y)));
}
