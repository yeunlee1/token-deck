// 업데이트 확인 전에 Tauri 메인 창을 표시하고 복원한 뒤 포커스하는지 검증한다
import { afterEach, describe, expect, it, vi } from "vitest";

const appWindow = vi.hoisted(() => ({
  show: vi.fn(async () => undefined),
  unminimize: vi.fn(async () => undefined),
  setFocus: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => appWindow }));

import { revealUpdatePrompt } from "./update-prompt";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("revealUpdatePrompt", () => {
  it("브라우저에서는 창 API를 호출하지 않는다", async () => {
    await revealUpdatePrompt();
    expect(appWindow.show).not.toHaveBeenCalled();
  });

  it("데스크톱에서는 숨김 창을 표시하고 최소화를 해제한 다음 포커스한다", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });

    await revealUpdatePrompt();

    expect(appWindow.show).toHaveBeenCalledOnce();
    expect(appWindow.unminimize).toHaveBeenCalledOnce();
    expect(appWindow.setFocus).toHaveBeenCalledOnce();
    expect(appWindow.show.mock.invocationCallOrder[0]).toBeLessThan(appWindow.unminimize.mock.invocationCallOrder[0]);
    expect(appWindow.unminimize.mock.invocationCallOrder[0]).toBeLessThan(appWindow.setFocus.mock.invocationCallOrder[0]);
  });
});
