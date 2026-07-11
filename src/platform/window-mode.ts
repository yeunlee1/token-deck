// Token Deck 메인 창을 일반 대시보드와 오른쪽 아래 미니 패널 크기로 전환한다
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";

const MINI_WIDTH = 430;
const MINI_HEIGHT = 360;
const NORMAL_WIDTH = 1280;
const NORMAL_HEIGHT = 820;
const EDGE_GAP = 22;

export interface WindowModeSpec {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  decorations: boolean;
  alwaysOnTop: boolean;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function getWindowModeSpec(mini: boolean, pinned = false): WindowModeSpec {
  return {
    width: mini ? MINI_WIDTH : NORMAL_WIDTH,
    height: mini ? MINI_HEIGHT : NORMAL_HEIGHT,
    minWidth: mini ? MINI_WIDTH : 920,
    minHeight: mini ? MINI_HEIGHT : 640,
    decorations: !mini,
    alwaysOnTop: pinned,
  };
}

export async function setWindowPinned(pinned: boolean): Promise<void> {
  if (!isTauriRuntime()) return;
  await getCurrentWindow().setAlwaysOnTop(pinned);
}

export async function applyWindowMode(mini: boolean, pinned = false): Promise<void> {
  if (!isTauriRuntime()) return;
  const appWindow = getCurrentWindow();
  const monitor = await currentMonitor();
  const spec = getWindowModeSpec(mini, pinned);

  await appWindow.setDecorations(spec.decorations);
  await appWindow.setMinSize(new LogicalSize(spec.minWidth, spec.minHeight));
  await appWindow.setSize(new LogicalSize(spec.width, spec.height));
  await setWindowPinned(spec.alwaysOnTop);

  if (!monitor) return;
  const scale = monitor.scaleFactor;
  const position = monitor.position.toLogical(scale);
  const size = monitor.size.toLogical(scale);
  const x = mini ? position.x + size.width - spec.width - EDGE_GAP : position.x + Math.max(0, (size.width - spec.width) / 2);
  const y = mini ? position.y + size.height - spec.height - EDGE_GAP : position.y + Math.max(0, (size.height - spec.height) / 2);
  await appWindow.setPosition(new LogicalPosition(Math.round(x), Math.round(y)));
}
