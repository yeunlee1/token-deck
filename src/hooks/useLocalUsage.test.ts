// 선택한 공급사의 사용 이벤트만 화면과 동기화 계층에 전달하는지 검증한다
import { describe, expect, it, vi } from "vitest";
import type { UsageEvent } from "../core";
import { collectorStateFromUsageEvents, finalizeLocalUsageScan, mergeLocalUsageEvents, restoreLocalUsageCache, restoreLocalUsageState, runFreshScanAfterPending, selectEnabledUsageEvents, updateProviderSelectionGeneration } from "./useLocalUsage";

function event(provider: UsageEvent["provider"]): UsageEvent {
  return {
    id: provider,
    provider,
    source: "local-jsonl",
    deviceId: "device-1",
    sessionId: `session-${provider}`,
    projectId: "project-1",
    occurredAt: "2026-07-13T00:00:00.000Z",
    tokens: { input: 1, cached: 0, output: 0, reasoning: 0, tool: 0 },
  };
}

describe("enabled provider usage", () => {
  it("내부 기록을 변경하지 않고 선택한 공급사만 반환한다", () => {
    const collected = [event("codex"), event("claude"), event("gemini")];

    expect(selectEnabledUsageEvents(collected, ["codex"]).map((item) => item.provider)).toEqual(["codex"]);
    expect(collected.map((item) => item.provider)).toEqual(["codex", "claude", "gemini"]);
  });

  it("A에서 B를 거쳐 A로 돌아와도 이전 A 작업과 다른 세대를 사용한다", () => {
    const firstA = { key: "codex|gemini", generation: 0 };
    const selectionB = updateProviderSelectionGeneration(firstA, "codex");
    const secondA = updateProviderSelectionGeneration(selectionB, "codex|gemini");

    expect(selectionB.generation).toBe(1);
    expect(secondA.generation).toBe(2);
    expect(secondA.generation).not.toBe(firstA.generation);
    expect(updateProviderSelectionGeneration(secondA, secondA.key)).toBe(secondA);
  });

  it("재시작 캐시를 먼저 적용한 뒤에만 다음 초기화 단계를 진행한다", async () => {
    let finishLoad!: (events: UsageEvent[]) => void;
    const load = vi.fn(() => new Promise<UsageEvent[]>((resolve) => { finishLoad = resolve; }));
    const loadNames = vi.fn(async () => ({ project_1: "Token Deck" }));
    const apply = vi.fn();
    const restoring = restoreLocalUsageCache(load, loadNames, apply);

    await Promise.resolve();
    expect(apply).not.toHaveBeenCalled();

    const cached = [event("codex")];
    finishLoad(cached);
    await restoring;
    expect(apply).toHaveBeenCalledWith(cached, { project_1: "Token Deck" });
  });

  it("소유권 기준선 같은 비동기 준비가 끝날 때까지 캐시 복원을 완료하지 않는다", async () => {
    let finishPrepare!: () => void;
    const apply = vi.fn(() => new Promise<void>((resolve) => { finishPrepare = resolve; }));
    let restored = false;
    const restoring = restoreLocalUsageCache(
      async () => [event("codex")],
      async () => ({}),
      apply,
    ).then(() => { restored = true; });

    await Promise.resolve();
    await Promise.resolve();
    expect(apply).toHaveBeenCalledOnce();
    expect(restored).toBe(false);

    finishPrepare();
    await restoring;
    expect(restored).toBe(true);
  });

  it("캐시 복원에 실패하면 준비 콜백을 실행하지 않는다", async () => {
    const apply = vi.fn();

    await expect(restoreLocalUsageCache(
      async () => { throw new Error("손상된 캐시"); },
      async () => ({}),
      apply,
    )).rejects.toThrow("손상된 캐시");
    expect(apply).not.toHaveBeenCalled();
  });

  it("프로젝트 이름 캐시가 손상돼도 이벤트와 소유권 상태를 복원한다", async () => {
    const ownership = { version: 1 as const, knownEventIds: ["codex"], owners: {} };
    const codexCumulative = {
      "device-1:session-codex": { input: 50_001, cached: 100, output: 25, reasoning: 5, tool: 1 },
    };
    const apply = vi.fn();

    await restoreLocalUsageState(
      async () => ({
        events: [event("codex")],
        ownership,
        codexCumulative,
        codexRetiredSessionFilter: "retired-filter",
      }),
      async () => { throw new Error("손상된 프로젝트 이름"); },
      apply,
    );

    expect(apply).toHaveBeenCalledWith(
      [event("codex")],
      ownership,
      codexCumulative,
      "retired-filter",
      {},
    );
  });

  it("캐시 이벤트와 새 이벤트를 ID로 병합해 재시작 기록을 유지한다", () => {
    const cached = event("codex");
    const corrected = { ...cached, tokens: { ...cached.tokens, input: 9 } };
    const merged = mergeLocalUsageEvents([cached], [corrected, event("claude")]);

    expect(merged).toHaveLength(2);
    expect(merged.find((item) => item.id === cached.id)?.tokens.input).toBe(9);
  });

  it("캐시에서 Codex 누적 토큰과 Claude 요청 ID를 복원한다", () => {
    const first = { ...event("codex"), id: "codex-1", sessionId: "session-1", tokens: { input: 10, cached: 2, output: 3, reasoning: 1, tool: 0 } };
    const second = { ...event("codex"), id: "codex-2", sessionId: "session-1", tokens: { input: 4, cached: 1, output: 2, reasoning: 0, tool: 1 } };
    const claude = { ...event("claude"), requestId: "request-1" };

    const state = collectorStateFromUsageEvents([first, second, claude]);

    expect(state.codexCumulative["device-1:session-1"]).toEqual({ input: 14, cached: 3, output: 5, reasoning: 1, tool: 1 });
    expect(state.claudeRequestIds.has("device-1:request-1")).toBe(true);
  });

  it("캐시 저장이 끝난 뒤에만 네이티브 커서를 커밋한다", async () => {
    let finishPersist!: () => void;
    const persist = vi.fn(() => new Promise<void>((resolve) => { finishPersist = resolve; }));
    const commit = vi.fn(async () => true);
    const loadStatus = vi.fn(async () => ({ codex: true, claude: false, gemini: false }));
    const finalizing = finalizeLocalUsageScan(persist, commit, () => true, loadStatus);

    await Promise.resolve();
    expect(commit).not.toHaveBeenCalled();
    expect(loadStatus).not.toHaveBeenCalled();

    finishPersist();
    await expect(finalizing).resolves.toEqual({
      committed: true,
      status: { codex: true, claude: false, gemini: false },
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(loadStatus).toHaveBeenCalledOnce();
  });

  it("캐시 저장이 실패하면 커서와 통합 상태를 건드리지 않는다", async () => {
    const commit = vi.fn(async () => true);
    const loadStatus = vi.fn(async () => ({ codex: true, claude: false, gemini: false }));

    await expect(finalizeLocalUsageScan(
      async () => { throw new Error("캐시 저장 실패"); },
      commit,
      () => true,
      loadStatus,
    )).rejects.toThrow("캐시 저장 실패");
    expect(commit).not.toHaveBeenCalled();
    expect(loadStatus).not.toHaveBeenCalled();
  });

  it("오래된 화면 세대라도 캐시와 커서는 마치고 상태 조회만 건너뛴다", async () => {
    const persist = vi.fn(async () => undefined);
    const commit = vi.fn(async () => true);
    const loadStatus = vi.fn(async () => ({ codex: true, claude: false, gemini: false }));

    await expect(finalizeLocalUsageScan(persist, commit, () => false, loadStatus))
      .resolves.toEqual({ committed: true });
    expect(persist).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    expect(loadStatus).not.toHaveBeenCalled();
  });

  it("통합 상태 조회가 실패해도 앞선 캐시와 커서 커밋은 유지한다", async () => {
    const order: string[] = [];

    await expect(finalizeLocalUsageScan(
      async () => { order.push("cache"); },
      async () => { order.push("commit"); return true; },
      () => true,
      async () => { order.push("status"); throw new Error("상태 조회 실패"); },
    )).rejects.toThrow("상태 조회 실패");
    expect(order).toEqual(["cache", "commit", "status"]);
  });

  it("계정 경계에서는 진행 중 수집을 기다린 뒤 새 수집을 반드시 한 번 더 실행한다", async () => {
    const order: string[] = [];
    let finishPending!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => { finishPending = resolve; })
      .then((value) => { order.push("pending"); return value; });
    const refresh = vi.fn(async () => { order.push("fresh"); return true; });
    const boundary = runFreshScanAfterPending(3, () => 3, pending, refresh);

    await Promise.resolve();
    expect(refresh).not.toHaveBeenCalled();
    finishPending(true);

    await expect(boundary).resolves.toBe(true);
    expect(order).toEqual(["pending", "fresh"]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("공급사 세대가 바뀌면 계정 경계의 후속 수집을 시작하지 않는다", async () => {
    const refresh = vi.fn(async () => true);

    await expect(runFreshScanAfterPending(3, () => 4, Promise.resolve(true), refresh))
      .resolves.toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });
});
