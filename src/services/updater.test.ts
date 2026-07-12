// 자동 업데이트의 확인·거절·설치·재실행 순서를 검증하는 테스트
import { describe, expect, it, vi } from "vitest";
import {
  executeUpdateFlow,
  runAppUpdateFlow,
  type AppUpdatePhase,
  type UpdateAdapter,
  type UpdateHandle,
} from "./updater";

function updateHandle(): UpdateHandle {
  return {
    currentVersion: "0.2.0",
    version: "0.3.0",
    date: "2026-07-12T00:00:00Z",
    body: "업데이트 안내",
    downloadAndInstall: vi.fn(async (onEvent) => {
      onEvent?.({ event: "Started", data: { contentLength: 100 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 40 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 60 } });
      onEvent?.({ event: "Finished" });
    }),
    close: vi.fn(async () => undefined),
  };
}

describe("app updater flow", () => {
  it("일반 브라우저에서는 네이티브 업데이트를 시도하지 않는다", async () => {
    await expect(runAppUpdateFlow({ confirmUpdate: () => true })).resolves.toMatchObject({ phase: "unsupported" });
  });

  it("최신 버전이면 설치 확인 없이 종료한다", async () => {
    const adapter: UpdateAdapter = { check: vi.fn(async () => null), relaunch: vi.fn() };
    const confirmUpdate = vi.fn(() => true);

    const result = await executeUpdateFlow(adapter, { confirmUpdate });

    expect(result.phase).toBe("current");
    expect(confirmUpdate).not.toHaveBeenCalled();
    expect(adapter.relaunch).not.toHaveBeenCalled();
  });

  it("사용자가 거절하면 다운로드하지 않고 업데이트 리소스를 정리한다", async () => {
    const update = updateHandle();
    const adapter: UpdateAdapter = { check: vi.fn(async () => update), relaunch: vi.fn() };

    const result = await executeUpdateFlow(adapter, { confirmUpdate: () => false });

    expect(result.phase).toBe("declined");
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
    expect(update.close).toHaveBeenCalledOnce();
    expect(adapter.relaunch).not.toHaveBeenCalled();
  });

  it("동의하면 다운로드 진행률을 전달하고 설치 후 재실행한다", async () => {
    const update = updateHandle();
    const adapter: UpdateAdapter = { check: vi.fn(async () => update), relaunch: vi.fn(async () => undefined) };
    const phases: AppUpdatePhase[] = [];
    const states: Array<{ downloadedBytes: number; totalBytes: number | null }> = [];

    const result = await executeUpdateFlow(adapter, {
      confirmUpdate: () => true,
      onState: (next) => {
        phases.push(next.phase);
        states.push({ downloadedBytes: next.downloadedBytes, totalBytes: next.totalBytes });
      },
    });

    expect(phases).toEqual([
      "checking", "available", "downloading", "downloading",
      "downloading", "downloading", "installing", "relaunching",
    ]);
    expect(states).toContainEqual({ downloadedBytes: 100, totalBytes: 100 });
    expect(update.close).toHaveBeenCalledOnce();
    expect(adapter.relaunch).toHaveBeenCalledOnce();
    expect(result.phase).toBe("relaunching");
  });
});
