// 동기화된 계정 API 토큰과 비용이 재시작 후에도 설정 요약에 복원되는지 검증하는 테스트
import { describe, expect, it, vi } from "vitest";
import type { DeviceInventoryItem, UsageEvent } from "../services";
import { decodeOwnedProviderSecret, encodeOwnedProviderSecret } from "../services/credential-store";
import {
  commitSession,
  claimAccountLocalEvents,
  createSerialTaskRunner,
  createUsageSyncCache,
  filterAccountLocalEvents,
  loadStoredSession,
  localEventsToTitledSyncEvents,
  markSessionTombstone,
  mergeAccountProviderUsage,
  providerEventsForOwner,
  providerCredentialOwner,
  readInventorySyncPreference,
  reconcileDownloadedUsage,
  recordUploadedUsage,
  requireOneTimeAuthCode,
  resolveSupabaseConfig,
  selectChangedUsageEvents,
  selectRemoteInventoryItems,
  shouldFullyReconcile,
  writeInventorySyncPreference,
} from "./useAppRuntime";

describe("account provider usage summary", () => {
  it("원격 토큰·비용을 복원하고 현재 조회값으로 같은 버킷을 갱신한다", () => {
    const token = syncEvent({ eventId: "provider_openai_deadbeef", provider: "openai", source: "provider_api", inputTokens: 10 });
    const corrected = { provider: "openai" as const, kind: "tokens" as const, occurredAt: token.occurredAt, projectRef: token.projectId, inputTokens: 20, raw: {} };
    const cost = syncEvent({ eventId: "provider_google_cost", provider: "google", source: "cloud_billing", metadata: { amount: 1.25, currency: "USD" } });

    const result = mergeAccountProviderUsage([token, cost], [corrected]);

    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "openai", inputTokens: 20 }),
      expect.objectContaining({ provider: "google", kind: "cost", amount: 1.25, currency: "USD" }),
    ]));
    expect(result).toHaveLength(2);
  });

  it("A 계정에서 만든 공급사 이벤트를 B 계정 동기화에서 제외한다", () => {
    const events = [syncEvent({ eventId: "provider-a" })];

    expect(providerEventsForOwner(events, "scope\nuser-a", "scope\nuser-b")).toEqual([]);
    expect(providerEventsForOwner(events, "scope\nuser-a", "scope\nuser-a")).toEqual(events);
    expect(providerEventsForOwner(events, undefined, "scope\nuser-b")).toEqual([]);
  });

  it("계정 전환 시 UI 연결 상태가 새 계정 소유자 기준으로 다시 계산된다", () => {
    const config = { url: "https://example.supabase.co", anonKey: "sb_publishable_test" };
    const ownerA = providerCredentialOwner("authenticated", "user-a", config, "device-1");
    const ownerB = providerCredentialOwner("authenticated", "user-b", config, "device-1");
    const stored = encodeOwnedProviderSecret(ownerA ?? "", JSON.stringify({ adminApiKey: "secret-a" }), "marker-a");

    expect(ownerA).not.toBe(ownerB);
    expect(decodeOwnedProviderSecret(stored, ownerA ?? "")).toBeDefined();
    expect(decodeOwnedProviderSecret(stored, ownerB ?? "")).toBeUndefined();
  });
});

describe("인증 세션 경쟁 조건", () => {
  it("자격 증명 저장이 끝나기 전에는 세션을 승인하지 않고 세대가 바뀌면 폐기한다", async () => {
    let generation = 7;
    let finishPersist!: (marker: string) => void;
    const persist = vi.fn(() => new Promise<string>((resolve) => { finishPersist = resolve; }));
    const accept = vi.fn();
    const discard = vi.fn().mockResolvedValue(undefined);
    const commit = commitSession({ accessToken: "account-a", userId: "user-a" }, generation, "scope-a", {
      currentGeneration: () => generation,
      currentScope: () => "scope-a",
      persist,
      discard,
      accept,
    });

    expect(accept).not.toHaveBeenCalled();
    generation += 1;
    finishPersist("marker-a");

    await expect(commit).resolves.toBe(false);
    expect(discard).toHaveBeenCalledWith("marker-a");
    expect(accept).not.toHaveBeenCalled();
  });

  it("같은 세대와 범위에서 저장에 성공한 뒤에만 세션을 승인한다", async () => {
    const order: string[] = [];
    const accepted = await commitSession({ accessToken: "account-b", userId: "user-b" }, 3, "scope-b", {
      currentGeneration: () => 3,
      currentScope: () => "scope-b",
      persist: async () => { order.push("persist"); return "marker-b"; },
      discard: async () => undefined,
      accept: () => { order.push("accept"); },
    });

    expect(accepted).toBe(true);
    expect(order).toEqual(["persist", "accept"]);
  });

  it("자격 증명 저장이 실패하면 세션을 승인하지 않는다", async () => {
    const accept = vi.fn();

    await expect(commitSession({ accessToken: "account-c", userId: "user-c" }, 4, "scope-c", {
      currentGeneration: () => 4,
      currentScope: () => "scope-c",
      persist: async () => { throw new Error("Credential Manager 저장 실패"); },
      discard: async () => undefined,
      accept,
    })).rejects.toThrow("저장 실패");

    expect(accept).not.toHaveBeenCalled();
  });

  it("동기화 작업 전체를 하나의 직렬 잠금으로 실행한다", async () => {
    const runSerial = createSerialTaskRunner();
    let releaseFirst!: () => void;
    let active = 0;
    let maximumActive = 0;
    const order: string[] = [];
    const first = runSerial(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push("first-start");
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      order.push("first-end");
      active -= 1;
    });
    const second = runSerial(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push("second-start");
      active -= 1;
    });

    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);

    expect(maximumActive).toBe(1);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });
});

describe("증분 계정 동기화", () => {
  it("두 번째 동기화는 기존 8만 건을 다시 업로드하거나 전체 조회하지 않는다", () => {
    const now = Date.parse("2026-07-12T00:00:00.000Z");
    const physicalDeviceId = "00000000-0000-0000-0000-000000000001";
    const events = Array.from({ length: 80_000 }, (_, index) => syncEvent({
      eventId: `event-${index}`,
      deviceId: physicalDeviceId,
      inputTokens: index,
    }));
    const cache = createUsageSyncCache("scope\nuser-a");

    expect(shouldFullyReconcile(cache, now)).toBe(true);
    reconcileDownloadedUsage(cache, [], true, now);
    const firstUpload = selectChangedUsageEvents(cache, events);
    expect(firstUpload).toHaveLength(80_000);
    recordUploadedUsage(cache, firstUpload);
    expect(cache.cursor).toBe("2026-07-11T23:55:00.000Z");

    const secondSyncAt = now + 60_000;
    expect(shouldFullyReconcile(cache, secondSyncAt)).toBe(false);
    const incrementalResponse = events.filter((item) => item.deviceId !== physicalDeviceId);
    expect(incrementalResponse).toEqual([]);
    reconcileDownloadedUsage(cache, incrementalResponse, false, secondSyncAt);
    expect(selectChangedUsageEvents(cache, events)).toEqual([]);
    expect(shouldFullyReconcile(cache, now + 6 * 60 * 60 * 1_000)).toBe(true);
  });

  it("A 조회 뒤 B 이벤트가 삽입되고 A가 업로드해도 읽기 커서는 B 이벤트 이전에 남는다", () => {
    const physicalDeviceId = "00000000-0000-0000-0000-000000000001";
    const cache = createUsageSyncCache("scope\nuser-a");
    const seed = syncEvent({
      eventId: "seed",
      deviceId: physicalDeviceId,
      createdAt: "2026-07-12T00:00:00.000Z",
    });
    reconcileDownloadedUsage(cache, [seed], true, Date.parse("2026-07-12T00:00:00.000Z"));

    const remoteR = syncEvent({
      eventId: "remote-r",
      deviceId: "00000000-0000-0000-0000-000000000002",
      createdAt: "2026-07-12T00:00:01.000Z",
    });
    const localL = syncEvent({ eventId: "local-l", deviceId: physicalDeviceId });
    recordUploadedUsage(cache, [localL]);

    expect(cache.cursor).toBe("2026-07-12T00:00:00.000Z");
    const nextIncrementalResponse = [seed, remoteR, localL]
      .filter((item) => item.createdAt && item.createdAt >= (cache.cursor ?? ""))
      .filter((item) => item.deviceId !== physicalDeviceId);
    reconcileDownloadedUsage(cache, nextIncrementalResponse, false, Date.parse("2026-07-12T00:01:00.000Z"));
    expect(cache.remoteEvents.get("remote-r")).toEqual(remoteR);
  });

  it("계정 전환용 새 캐시는 이전 계정 fingerprint와 원격 이벤트를 물려받지 않는다", () => {
    const accountA = createUsageSyncCache("scope\nuser-a");
    const item = syncEvent({ eventId: "account-a-event", createdAt: "2026-07-12T00:00:00.000Z" });
    reconcileDownloadedUsage(accountA, [item], true, Date.parse("2026-07-12T00:00:00.000Z"));

    const accountB = createUsageSyncCache("scope\nuser-b");

    expect(accountB.fingerprints.size).toBe(0);
    expect(accountB.remoteEvents.size).toBe(0);
    expect(selectChangedUsageEvents(accountB, [item])).toEqual([item]);
  });
});

describe("계정별 로컬 사용량 격리", () => {
  it("처음 동기화한 계정이 로컬 세션을 소유하고 다른 계정에는 보이지 않는다", () => {
    const local = localEvent({ id: "local-a", provider: "codex", deviceId: "device-1", sessionId: "session-1" });
    const claimedA = claimAccountLocalEvents({}, [local], "scope\nuser-a");
    const claimedB = claimAccountLocalEvents(claimedA.ownership, [local], "scope\nuser-b");

    expect(claimedA.events).toEqual([local]);
    expect(claimedB.events).toEqual([]);
    expect(filterAccountLocalEvents([local], claimedA.ownership, "scope\nuser-a")).toEqual([local]);
    expect(filterAccountLocalEvents([local], claimedA.ownership, "scope\nuser-b")).toEqual([]);
  });

  it("같은 세션에서 새로 만들어진 로컬 이벤트도 현재 계정에 귀속된다", () => {
    const first = localEvent({ id: "local-a", provider: "codex", deviceId: "device-1", sessionId: "session-1" });
    const second = localEvent({ id: "local-b", provider: "codex", deviceId: "device-1", sessionId: "session-1" });
    const claimedA = claimAccountLocalEvents({}, [first], "scope\nuser-a");
    const claimedB = claimAccountLocalEvents(claimedA.ownership, [first, second], "scope\nuser-b");

    expect(claimedB.events).toEqual([second]);
    expect(filterAccountLocalEvents([first, second], claimedB.ownership, "scope\nuser-a")).toEqual([first]);
    expect(filterAccountLocalEvents([first, second], claimedB.ownership, "scope\nuser-b")).toEqual([second]);
  });

  it("동기화용 해시 세션 ID로 바꿔도 제목은 원본 로컬 세션 ID에서 가져온다", () => {
    const local = localEvent({ id: "local-title", provider: "codex", deviceId: "device-1", sessionId: "raw-session" });
    const [synced] = localEventsToTitledSyncEvents([local], { "raw-session": "사용자 제목" });

    expect(synced.sessionId).not.toBe("raw-session");
    expect(synced.sessionTitle).toBe("사용자 제목");
  });
});

describe("기기 설정 인벤토리 계정 격리", () => {
  it("설정 목록 동기화 동의를 계정별로 분리해 저장한다", () => {
    const storage = new MemoryStorage();
    writeInventorySyncPreference("scope\nuser-a", true, storage);

    expect(readInventorySyncPreference("scope\nuser-a", storage)).toBe(true);
    expect(readInventorySyncPreference("scope\nuser-b", storage)).toBe(false);
    expect(readInventorySyncPreference(undefined, storage)).toBe(false);
  });

  it("현재 기기와 수동 항목을 제외하고 원격 스냅샷의 정규 항목만 적용한다", () => {
    const transferable = inventoryItem({ key: "formatter@market", transferable: true });
    const manual = inventoryItem({ kind: "mcp", key: "private-mcp", transferable: false });
    const snapshots = [
      { deviceId: "current", schemaVersion: 1 as const, capturedAt: 1, contentHash: "a".repeat(64), items: [inventoryItem({ key: "current-only", transferable: true })] },
      { deviceId: "remote", schemaVersion: 1 as const, capturedAt: 2, contentHash: "b".repeat(64), items: [transferable, manual] },
    ];

    const selected = selectRemoteInventoryItems(snapshots, "current", "remote", [
      transferable,
      manual,
      inventoryItem({ key: "current-only", transferable: true }),
    ]);

    expect(selected).toEqual([transferable]);
    expect(selectRemoteInventoryItems(snapshots, "current", "remote", [
      { ...transferable, displayName: "변조된 이름", version: "999" },
    ])).toEqual([]);
  });

  it("같은 플러그인 키가 여러 기기에 있어도 사용자가 고른 원본 기기와 버전에 묶는다", () => {
    const versionOne = inventoryItem({ key: "shared@market", version: "1.0.0" });
    const versionTwo = inventoryItem({ key: "shared@market", version: "2.0.0" });
    const snapshots = [
      { deviceId: "laptop", schemaVersion: 1 as const, capturedAt: 1, contentHash: "d".repeat(64), items: [versionOne] },
      { deviceId: "desktop", schemaVersion: 1 as const, capturedAt: 2, contentHash: "e".repeat(64), items: [versionTwo] },
    ];

    expect(selectRemoteInventoryItems(snapshots, "current", "laptop", [versionOne])).toEqual([versionOne]);
    expect(selectRemoteInventoryItems(snapshots, "current", "laptop", [versionTwo])).toEqual([]);
    expect(selectRemoteInventoryItems(snapshots, "current", "current", [versionOne])).toEqual([]);
  });

  it("현재 기기에 이미 설치된 Gemini 확장만 원격 목록에서 다시 활성화할 수 있다", () => {
    const remoteGemini = inventoryItem({ provider: "gemini", key: "gemini-extension", transferable: false });
    const snapshot = { deviceId: "remote", schemaVersion: 1 as const, capturedAt: 2, contentHash: "c".repeat(64), items: [remoteGemini] };

    expect(selectRemoteInventoryItems([snapshot], "current", "remote", [remoteGemini], [])).toEqual([]);
    expect(selectRemoteInventoryItems([snapshot], "current", "remote", [remoteGemini], [
      { ...remoteGemini, enabled: false, installed: true },
    ])).toEqual([remoteGemini]);
  });
});

describe("로그아웃과 콜백 방어", () => {
  it("Credential Manager 삭제가 실패해도 tombstone이 재시작 세션 복원을 차단한다", async () => {
    const storage = new MemoryStorage();
    const scope = "https://example.supabase.co\nsb_publishable_test";
    const loadSecret = vi.fn().mockResolvedValue(JSON.stringify({
      scope,
      session: { accessToken: "stale-access", refreshToken: "stale-refresh", userId: "user-a" },
    }));
    const removeSecret = vi.fn().mockRejectedValue(new Error("Credential Manager 삭제 실패"));
    markSessionTombstone(scope, storage);
    await removeSecret().catch(() => undefined);

    const restored = await loadStoredSession(scope, storage, loadSecret);

    expect(restored).toBeNull();
    expect(removeSecret).toHaveBeenCalledOnce();
    expect(loadSecret).not.toHaveBeenCalled();
  });

  it("쿼리의 일회용 코드만 허용하고 implicit 토큰 fragment를 거부한다", () => {
    expect(requireOneTimeAuthCode("token-deck://auth?state=s&code=one-time")).toBe("one-time");
    expect(() => requireOneTimeAuthCode("token-deck://auth?state=s#access_token=access&refresh_token=refresh"))
      .toThrow("일회용 인증 코드");
  });

  it("저장 설정이 없을 때 빌드 기본 Supabase 설정을 그대로 사용한다", () => {
    const buildDefault = { url: "https://build.supabase.co", anonKey: "sb_publishable_build" };
    expect(resolveSupabaseConfig(null, buildDefault)).toEqual(buildDefault);
    expect(resolveSupabaseConfig({ url: "https://saved.supabase.co", anonKey: "sb_publishable_saved" }, buildDefault))
      .toEqual({ url: "https://saved.supabase.co", anonKey: "sb_publishable_saved" });
  });
});

function syncEvent(overrides: Partial<UsageEvent>): UsageEvent {
  return {
    eventId: "event-1", provider: "openai", source: "provider_api",
    deviceId: "00000000-0000-4000-8000-000000000001", projectId: "project-1",
    occurredAt: "2026-07-11T00:00:00.000Z", inputTokens: 0, cachedTokens: 0,
    outputTokens: 0, reasoningTokens: 0, toolTokens: 0, ...overrides,
  };
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

function localEvent(overrides: Partial<import("../core").UsageEvent>): import("../core").UsageEvent {
  return {
    id: "local-1",
    provider: "codex",
    source: "local-jsonl",
    deviceId: "device-1",
    sessionId: "session-1",
    projectId: "project-1",
    occurredAt: "2026-07-11T00:00:00.000Z",
    tokens: { input: 1, cached: 0, output: 0, reasoning: 0, tool: 0 },
    ...overrides,
  };
}

function inventoryItem(overrides: Partial<DeviceInventoryItem>): DeviceInventoryItem {
  return {
    provider: "codex",
    kind: "plugin",
    key: "plugin@market",
    displayName: "Plugin",
    enabled: true,
    installed: true,
    source: "marketplace",
    marketplace: "market",
    hasSecrets: false,
    transferable: true,
    ...overrides,
  };
}
