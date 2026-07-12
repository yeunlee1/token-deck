// 업데이트 감시기의 주기 확인과 온라인 복구 및 중복 프롬프트 방지를 검증한다
import { describe, expect, it, vi } from "vitest";
import {
  APP_UPDATE_CHECK_INTERVAL_MS,
  AutoUpdateMonitor,
  type AutoUpdateMonitorRuntime,
} from "./useAutoUpdater";
import {
  INITIAL_APP_UPDATE_STATE,
  UpdateCheckError,
  type AppUpdateInfo,
  type AppUpdateState,
  type UpdateFlowOptions,
} from "../services/updater";

const updateInfo: AppUpdateInfo = {
  currentVersion: "0.3.0",
  version: "0.3.1",
  date: null,
  body: null,
};

function updateState(phase: AppUpdateState["phase"]): AppUpdateState {
  return { ...INITIAL_APP_UPDATE_STATE, phase, update: updateInfo };
}

function runtime(runFlow: AutoUpdateMonitorRuntime["runFlow"]) {
  let intervalCallback: (() => void) | undefined;
  let onlineCallback: (() => void) | undefined;
  const adapter: AutoUpdateMonitorRuntime = {
    runFlow,
    revealPrompt: vi.fn(async () => undefined),
    setInterval: vi.fn((callback, milliseconds) => {
      expect(milliseconds).toBe(APP_UPDATE_CHECK_INTERVAL_MS);
      intervalCallback = callback;
      return 7;
    }),
    clearInterval: vi.fn(),
    addOnlineListener: vi.fn((callback) => { onlineCallback = callback; }),
    removeOnlineListener: vi.fn(),
  };
  return {
    adapter,
    triggerInterval: () => intervalCallback?.(),
    triggerOnline: () => onlineCallback?.(),
  };
}

describe("AutoUpdateMonitor", () => {
  it("시작 즉시와 6시간 주기 및 온라인 복구 시 다시 확인한다", async () => {
    const runFlow = vi.fn(async () => updateState("current"));
    const testRuntime = runtime(runFlow);
    const monitor = new AutoUpdateMonitor({
      confirmUpdate: () => true,
      onState: vi.fn(),
      runtime: testRuntime.adapter,
    });

    monitor.start();
    await monitor.check();
    testRuntime.triggerInterval();
    await monitor.check();
    testRuntime.triggerOnline();
    await monitor.check();
    monitor.stop();

    expect(runFlow).toHaveBeenCalledTimes(3);
    expect(testRuntime.adapter.addOnlineListener).toHaveBeenCalledOnce();
    expect(testRuntime.adapter.clearInterval).toHaveBeenCalledWith(7);
    expect(testRuntime.adapter.removeOnlineListener).toHaveBeenCalledOnce();
  });

  it("확인이 진행 중이면 주기나 온라인 이벤트가 겹쳐도 같은 작업을 재사용한다", async () => {
    let finish!: (state: AppUpdateState) => void;
    const pending = new Promise<AppUpdateState>((resolve) => { finish = resolve; });
    const runFlow = vi.fn(() => pending);
    const testRuntime = runtime(runFlow);
    const monitor = new AutoUpdateMonitor({
      confirmUpdate: () => true,
      onState: vi.fn(),
      runtime: testRuntime.adapter,
    });

    const first = monitor.check();
    const second = monitor.check();
    expect(second).toBe(first);
    await Promise.resolve();
    expect(runFlow).toHaveBeenCalledOnce();

    finish(updateState("current"));
    await first;
  });

  it("거절한 동일 버전은 같은 프로세스에서 창을 다시 띄우거나 재질문하지 않는다", async () => {
    const runFlow = vi.fn(async (options: UpdateFlowOptions) => {
      const accepted = await options.confirmUpdate(updateInfo);
      return updateState(accepted ? "relaunching" : "declined");
    });
    const confirmUpdate = vi.fn(() => false);
    const testRuntime = runtime(runFlow);
    const monitor = new AutoUpdateMonitor({
      confirmUpdate,
      onState: vi.fn(),
      runtime: testRuntime.adapter,
    });

    await monitor.check();
    await monitor.check();

    expect(runFlow).toHaveBeenCalledTimes(2);
    expect(testRuntime.adapter.revealPrompt).toHaveBeenCalledOnce();
    expect(confirmUpdate).toHaveBeenCalledOnce();
  });

  it("숨김 창을 먼저 표시한 뒤 사용자에게 업데이트 여부를 묻는다", async () => {
    const calls: string[] = [];
    const runFlow = vi.fn(async (options: UpdateFlowOptions) => {
      await options.confirmUpdate(updateInfo);
      return updateState("declined");
    });
    const testRuntime = runtime(runFlow);
    testRuntime.adapter.revealPrompt = vi.fn(async () => { calls.push("창 표시"); });
    const monitor = new AutoUpdateMonitor({
      confirmUpdate: () => { calls.push("설치 확인"); return false; },
      onState: vi.fn(),
      runtime: testRuntime.adapter,
    });

    await monitor.check();

    expect(calls).toEqual(["창 표시", "설치 확인"]);
  });

  it("미게시 latest.json 404는 일반 오류 대신 조용한 메타데이터 부재 상태로 둔다", async () => {
    const onState = vi.fn();
    const testRuntime = runtime(vi.fn(async () => {
      throw new UpdateCheckError("요청 상태 코드 404");
    }));
    const monitor = new AutoUpdateMonitor({
      confirmUpdate: () => true,
      onState,
      runtime: testRuntime.adapter,
    });

    const result = await monitor.check();

    expect(result).toMatchObject({ phase: "metadata-missing", error: null });
    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "metadata-missing", error: null }));
  });

  it("상태를 알 수 없는 범용 릴리스 오류는 404로 추정하지 않는다", async () => {
    const onState = vi.fn();
    const testRuntime = runtime(vi.fn(async () => {
      throw new UpdateCheckError("Could not fetch a valid release JSON from the remote");
    }));
    const monitor = new AutoUpdateMonitor({
      confirmUpdate: () => true,
      onState,
      runtime: testRuntime.adapter,
    });

    const result = await monitor.check();

    expect(result).toMatchObject({
      phase: "error",
      error: "Could not fetch a valid release JSON from the remote",
    });
    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "error" }));
  });
});
