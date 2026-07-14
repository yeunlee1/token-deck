// 동기화된 계정 API 토큰과 비용이 재시작 후에도 설정 요약에 복원되는지 검증하는 테스트
import { describe, expect, it, vi } from "vitest";
import { SupabaseRestClient, UsageSyncService, type DeviceInventoryItem, type UsageEvent } from "../services";
import { decodeOwnedProviderSecret, encodeOwnedProviderSecret } from "../services/credential-store";
import {
  cancelPendingAuthAttempt,
  commitSession,
  claimAccountLocalEvents,
  clearStalePendingSession,
  clearProductionSupabaseOverride,
  compactSessionForStorage,
  createCredentialRevisionTracker,
  createSerialTaskRunner,
  createUsageSyncCache,
  filterAccountLocalEvents,
  flushLocalUsageAccountBoundary,
  hasInventorySyncPreference,
  loadStoredSession,
  localEventsToTitledSyncEvents,
  localUsageOwnerHash,
  markSessionTombstone,
  markInventoryLoginConsent,
  mergeAccountProjectNames,
  mergeAccountProviderUsage,
  migrateLocalUsageOwnership,
  providerEventsForOwner,
  providerCredentialOwner,
  pruneLocalUsageOwnership,
  readInventorySyncPreference,
  readAccountProjectNameOverrides,
  consumeInventoryLoginConsent,
  reconcileDownloadedUsage,
  recordUploadedUsage,
  requireOneTimeAuthCode,
  resolveSupabaseConfig,
  runCredentialMutation,
  sealLocalUsageOwnershipBaseline,
  selectLocalUsagePersistenceSnapshot,
  selectRetainedLocalUsageClaimEvents,
  selectChangedUsageEvents,
  selectRemoteInventoryItems,
  settleWithin,
  shouldFullyReconcile,
  syncProvidersForUsageProviders,
  writeInventorySyncPreference,
  writeAccountProjectNameOverrides,
} from "./useAppRuntime";

describe("account provider usage summary", () => {
  it("선택 공급사의 로컬 이벤트와 계정 API 이벤트만 원격 조회 대상으로 만든다", () => {
    expect(syncProvidersForUsageProviders(["codex", "gemini"]))
      .toEqual(["codex", "openai", "gemini", "google"]);
  });

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
  it("재시작 시 남은 전환 대기 세션 정리에 실패하면 오류를 숨기지 않는다", async () => {
    const remove = vi.fn().mockRejectedValue(new Error("Credential Manager 삭제 실패"));

    await expect(clearStalePendingSession(remove)).rejects.toThrow("삭제 실패");
    expect(remove).toHaveBeenCalledOnce();
  });

  it("계정 전환과 로그아웃 전에 현재 계정의 미수집 사용량 경계를 완료한다", async () => {
    const refresh = vi.fn(async () => true);

    await expect(flushLocalUsageAccountBoundary("account-a", "account-b", refresh)).resolves.toBe(true);
    await expect(flushLocalUsageAccountBoundary("account-a", undefined, refresh)).resolves.toBe(true);
    await expect(flushLocalUsageAccountBoundary("account-a", "account-a", refresh)).resolves.toBe(true);

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("현재 계정의 사용량 경계 저장이 실패하면 계정 전환을 허용하지 않는다", async () => {
    await expect(flushLocalUsageAccountBoundary(
      "account-a",
      "account-b",
      async () => false,
    )).resolves.toBe(false);
  });

  it("자격 증명을 교체하거나 삭제하면 이전 사용량 요청 세대를 폐기한다", () => {
    const revisions = createCredentialRevisionTracker();
    const openAiRequest = revisions.current("openai");
    const claudeRequest = revisions.current("anthropic");

    revisions.invalidate("openai");

    expect(revisions.matches("openai", openAiRequest)).toBe(false);
    expect(revisions.matches("anthropic", claudeRequest)).toBe(true);
  });

  it("대기 중이던 자격 증명 변경의 실행 전후에 시작된 사용량 요청을 모두 폐기한다", async () => {
    const revisions = createCredentialRevisionTracker();
    revisions.invalidate("openai");
    const queuedRequest = revisions.current("openai");
    let finishMutation!: () => void;
    const mutation = runCredentialMutation(revisions, "openai", () => new Promise<void>((resolve) => { finishMutation = resolve; }));
    const inFlightRequest = revisions.current("openai");

    expect(revisions.matches("openai", queuedRequest)).toBe(false);
    finishMutation();
    await mutation;

    expect(revisions.matches("openai", inFlightRequest)).toBe(false);
  });

  it("자격 증명 저장이 끝나기 전에는 세션을 승인하지 않고 세대가 바뀌면 폐기한다", async () => {
    let generation = 7;
    let finishStage!: (marker: string) => void;
    const stage = vi.fn(() => new Promise<string>((resolve) => { finishStage = resolve; }));
    const accept = vi.fn();
    const discardPending = vi.fn().mockResolvedValue(undefined);
    const promote = vi.fn().mockResolvedValue(undefined);
    const commit = commitSession({ accessToken: "account-a", userId: "user-a" }, generation, "scope-a", {
      currentGeneration: () => generation,
      currentScope: () => "scope-a",
      stage,
      discardPending,
      promote,
      discardPromoted: vi.fn().mockResolvedValue(undefined),
      accept,
    });

    expect(accept).not.toHaveBeenCalled();
    generation += 1;
    finishStage("marker-a");

    await expect(commit).resolves.toBe(false);
    expect(discardPending).toHaveBeenCalledWith("marker-a");
    expect(promote).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });

  it("같은 세대와 범위에서 저장에 성공한 뒤에만 세션을 승인한다", async () => {
    const order: string[] = [];
    const accepted = await commitSession({ accessToken: "account-b", userId: "user-b" }, 3, "scope-b", {
      currentGeneration: () => 3,
      currentScope: () => "scope-b",
      stage: async () => { order.push("stage"); return "marker-b"; },
      discardPending: async () => undefined,
      beforeAccept: async () => { order.push("boundary"); return true; },
      promote: async () => { order.push("promote"); },
      discardPromoted: async () => undefined,
      accept: () => { order.push("accept"); },
    });

    expect(accepted).toBe(true);
    expect(order).toEqual(["stage", "boundary", "promote", "accept"]);
  });

  it("계정 경계가 실패하면 대기 세션만 버리고 기존 활성 세션을 보존한다", async () => {
    let active = "account-a";
    let pending: string | undefined;
    const order: string[] = [];

    const accepted = await commitSession({ accessToken: "account-b", userId: "user-b" }, 3, "scope-b", {
      currentGeneration: () => 3,
      currentScope: () => "scope-b",
      stage: async () => { order.push("stage"); pending = "account-b"; return "marker-b"; },
      discardPending: async () => { order.push("discard-pending"); pending = undefined; },
      beforeAccept: async () => { order.push("boundary"); return false; },
      promote: async () => { order.push("promote"); active = pending ?? active; },
      discardPromoted: async () => { order.push("discard-promoted"); },
      accept: () => { order.push("accept"); },
    });

    expect(accepted).toBe(false);
    expect(active).toBe("account-a");
    expect(pending).toBeUndefined();
    expect(order).toEqual(["stage", "boundary", "discard-pending"]);
  });

  it("대기 세션 승격이 실패해도 기존 활성 세션을 보존하고 대기 슬롯을 정리한다", async () => {
    let active = "account-a";
    let pending: string | undefined;
    const discardPending = vi.fn(async () => { pending = undefined; });

    await expect(commitSession({ accessToken: "account-b", userId: "user-b" }, 3, "scope-b", {
      currentGeneration: () => 3,
      currentScope: () => "scope-b",
      stage: async () => { pending = "account-b"; return "marker-b"; },
      discardPending,
      beforeAccept: async () => true,
      promote: async () => { throw new Error("활성 슬롯 저장 실패"); },
      discardPromoted: async () => { active = ""; },
      accept: () => { active = pending ?? active; },
    })).rejects.toThrow("활성 슬롯 저장 실패");

    expect(active).toBe("account-a");
    expect(pending).toBeUndefined();
    expect(discardPending).toHaveBeenCalledWith("marker-b");
  });

  it("자격 증명 저장이 실패하면 세션을 승인하지 않는다", async () => {
    const accept = vi.fn();

    await expect(commitSession({ accessToken: "account-c", userId: "user-c" }, 4, "scope-c", {
      currentGeneration: () => 4,
      currentScope: () => "scope-c",
      stage: async () => { throw new Error("Credential Manager 저장 실패"); },
      discardPending: async () => undefined,
      promote: async () => undefined,
      discardPromoted: async () => undefined,
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
    expect(reconcileDownloadedUsage(cache, [], true, now)).toBe(true);
    const firstUpload = selectChangedUsageEvents(cache, events);
    expect(firstUpload).toHaveLength(80_000);
    recordUploadedUsage(cache, firstUpload);
    expect(cache.cursor).toBe("2026-07-11T23:55:00.000Z");

    const secondSyncAt = now + 60_000;
    expect(shouldFullyReconcile(cache, secondSyncAt)).toBe(false);
    const incrementalResponse = events.filter((item) => item.deviceId !== physicalDeviceId);
    expect(incrementalResponse).toEqual([]);
    expect(reconcileDownloadedUsage(cache, incrementalResponse, false, secondSyncAt)).toBe(false);
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
    expect(reconcileDownloadedUsage(cache, [seed], true, Date.parse("2026-07-12T00:00:00.000Z"))).toBe(true);

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
    expect(reconcileDownloadedUsage(cache, nextIncrementalResponse, false, Date.parse("2026-07-12T00:01:00.000Z"))).toBe(true);
    expect(cache.remoteEvents.get("remote-r")).toEqual(remoteR);
  });

  it("같은 원격 이벤트가 증분 조회에 다시 포함되면 화면용 참조를 바꾸지 않는다", () => {
    const cache = createUsageSyncCache("scope\nuser-a");
    const original = syncEvent({ eventId: "remote-a", createdAt: "2026-07-12T00:00:00.000Z" });
    expect(reconcileDownloadedUsage(cache, [original], true)).toBe(true);

    const duplicate = { ...original };

    expect(reconcileDownloadedUsage(cache, [duplicate], false)).toBe(false);
    expect(cache.remoteEvents.get(original.eventId)).toBe(original);
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
  it("이전 화면 스냅샷으로 동기화해도 방금 저장한 수집 이벤트와 누적 기준점을 제거하지 않는다", () => {
    const previous = localEvent({ id: "previous" });
    const newest = localEvent({ id: "newest" });
    const latestCheckpoint = {
      "device-1:session-1": { input: 200, cached: 20, output: 10, reasoning: 2, tool: 1 },
    };

    const snapshot = selectLocalUsagePersistenceSnapshot(
      false,
      [previous],
      { "device-1:session-1": { input: 100, cached: 10, output: 5, reasoning: 1, tool: 0 } },
      "old-filter",
      [previous, newest],
      latestCheckpoint,
      "latest-filter",
    );

    expect(snapshot.events).toEqual([previous, newest]);
    expect(snapshot.codexCumulative).toBe(latestCheckpoint);
    expect(snapshot.codexRetiredSessionFilter).toBe("latest-filter");
    expect(selectRetainedLocalUsageClaimEvents([previous], [newest])).toEqual([]);
  });

  it("처음 동기화한 계정이 로컬 세션을 소유하고 다른 계정에는 보이지 않는다", () => {
    const local = localEvent({ id: "local-a", provider: "codex", deviceId: "device-1", sessionId: "session-1" });
    const empty = { version: 1 as const, knownEventIds: [], owners: {} };
    const ownerA = localUsageOwnerHash("https://example.supabase.co", "user-a") ?? "";
    const ownerB = localUsageOwnerHash("https://example.supabase.co", "user-b") ?? "";
    const claimedA = claimAccountLocalEvents(empty, [local], ownerA);
    const claimedB = claimAccountLocalEvents(claimedA.ownership, [local], ownerB);

    expect(claimedA.events).toEqual([local]);
    expect(claimedB.events).toEqual([]);
    expect(filterAccountLocalEvents([local], claimedA.ownership, ownerA)).toEqual([local]);
    expect(filterAccountLocalEvents([local], claimedA.ownership, ownerB)).toEqual([]);
    expect(JSON.stringify(claimedA.ownership)).not.toContain("example.supabase.co");
  });

  it("같은 세션에서 새로 만들어진 로컬 이벤트도 현재 계정에 귀속된다", () => {
    const first = localEvent({ id: "local-a", provider: "codex", deviceId: "device-1", sessionId: "session-1" });
    const second = localEvent({ id: "local-b", provider: "codex", deviceId: "device-1", sessionId: "session-1" });
    const empty = { version: 1 as const, knownEventIds: [], owners: {} };
    const ownerA = localUsageOwnerHash("https://example.supabase.co", "user-a") ?? "";
    const ownerB = localUsageOwnerHash("https://example.supabase.co", "user-b") ?? "";
    const claimedA = claimAccountLocalEvents(empty, [first], ownerA);
    const claimedB = claimAccountLocalEvents(claimedA.ownership, [first, second], ownerB);

    expect(claimedB.events).toEqual([second]);
    expect(filterAccountLocalEvents([first, second], claimedB.ownership, ownerA)).toEqual([first]);
    expect(filterAccountLocalEvents([first, second], claimedB.ownership, ownerB)).toEqual([second]);
  });

  it("소유권 근거가 없는 기존 캐시는 다른 계정에 자동 귀속하지 않는다", () => {
    const existing = localEvent({ id: "legacy-event" });
    const migrated = migrateLocalUsageOwnership([existing], {});
    const owner = localUsageOwnerHash("https://example.supabase.co", "user-b") ?? "";

    const claim = claimAccountLocalEvents(migrated, [existing], owner);

    expect(claim.events).toEqual([]);
    expect(claim.ownership.knownEventIds).toEqual(["legacy-event"]);
    expect(claim.ownership.owners).toEqual({});
  });

  it("앱 종료 전에 소유권 저장이 끝나지 않은 캐시도 재시작 기준선에서 차단한다", () => {
    const persistedBeforeCrash = localEvent({ id: "crash-gap" });
    const existingState = { version: 1 as const, knownEventIds: [], owners: {} };
    const sealed = sealLocalUsageOwnershipBaseline(existingState, [persistedBeforeCrash]);
    const nextAccount = localUsageOwnerHash("https://example.supabase.co", "user-b") ?? "";

    const claim = claimAccountLocalEvents(sealed, [persistedBeforeCrash], nextAccount);

    expect(sealed.knownEventIds).toEqual(["crash-gap"]);
    expect(claim.events).toEqual([]);
  });

  it("캐시에서 제거된 이벤트가 다시 나타나도 다른 계정에 재귀속하지 않는다", () => {
    const local = localEvent({ id: "evicted-event" });
    const ownerA = localUsageOwnerHash("https://example.supabase.co", "user-a") ?? "";
    const ownerB = localUsageOwnerHash("https://example.supabase.co", "user-b") ?? "";
    const pruned = pruneLocalUsageOwnership({
      version: 1,
      knownEventIds: ["evicted-event"],
      owners: { "evicted-event": ownerA },
      seenFilter: "",
    }, []);

    const claim = claimAccountLocalEvents(pruned, [local], ownerB);

    expect(pruned.knownEventIds).toEqual([]);
    expect(pruned.seenFilter).not.toBe("");
    expect(claim.events).toEqual([]);
    expect(claim.ownership.owners).toEqual({});
  });

  it("검증 가능한 기존 장부만 짧은 계정 해시로 이전하고 보존 이벤트에 맞춰 정리한다", () => {
    const retained = localEvent({ id: "retained" });
    const removed = localEvent({ id: "removed" });
    const legacyOwner = "https://example.supabase.co\nsb_publishable_old\nuser-a";
    const migrated = migrateLocalUsageOwnership(
      [retained, removed],
      { retained: legacyOwner, removed: legacyOwner, ignored: "invalid" },
    );

    const pruned = pruneLocalUsageOwnership(migrated, [retained]);

    expect(pruned.knownEventIds).toEqual(["retained"]);
    expect(pruned.owners.retained).toBe(localUsageOwnerHash("https://example.supabase.co", "user-a"));
    expect(pruned.owners.removed).toBeUndefined();
    expect(JSON.stringify(pruned)).not.toContain("sb_publishable_old");
  });

  it("동기화용 해시 세션 ID로 바꿔도 제목은 원본 로컬 세션 ID에서 가져온다", () => {
    const local = localEvent({ id: "local-title", provider: "codex", deviceId: "device-1", sessionId: "raw-session" });
    const [synced] = localEventsToTitledSyncEvents([local], { "raw-session": "사용자 제목" });

    expect(synced.sessionId).not.toBe("raw-session");
    expect(synced.sessionTitle).toBe("사용자 제목");
  });
});

describe("계정별 프로젝트 이름 격리", () => {
  it("A 계정과 로컬 전용 이름을 B 계정의 표시·원격 삽입 이름에 섞지 않는다", async () => {
    const storage = new MemoryStorage();
    const ownerA = "scope\nuser-a";
    const ownerB = "scope\nuser-b";
    const projectId = `git_${"a".repeat(64)}`;
    storage.setItem("token-deck-project-names", JSON.stringify({ [projectId]: "로컬 전용 이름" }));
    writeAccountProjectNameOverrides(ownerA, { [projectId]: "A 비공개 이름" }, storage);
    writeAccountProjectNameOverrides(ownerB, { [projectId]: "B 계정 이름" }, storage);

    const namesForB = mergeAccountProjectNames(
      { [projectId]: "프로젝트 폴더 이름" },
      {},
      readAccountProjectNameOverrides(ownerB, storage),
    );
    const namesForNewAccount = mergeAccountProjectNames(
      { [projectId]: "프로젝트 폴더 이름" },
      {},
      readAccountProjectNameOverrides("scope\nuser-c", storage),
    );

    expect(readAccountProjectNameOverrides(ownerA, storage)).toEqual({ [projectId]: "A 비공개 이름" });
    expect(namesForB[projectId]).toBe("B 계정 이름");
    expect(namesForNewAccount[projectId]).toBe("프로젝트 폴더 이름");
    expect(storage.getItem("token-deck-project-names")).toBe(JSON.stringify({ [projectId]: "로컬 전용 이름" }));

    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new SupabaseRestClient({ url: "https://example.supabase.co", anonKey: "anon" }, request);
    client.setSession({ accessToken: "account-b" });
    await new UsageSyncService(client).upsertUsageEvents([syncEvent({
      eventId: "account-b-project-event",
      provider: "codex",
      source: "local_session",
      projectId,
    })], namesForB);

    const projectCall = request.mock.calls.find(([url]) => String(url).includes("/rest/v1/projects?"));
    const [inserted] = JSON.parse(String((projectCall?.[1] as RequestInit).body)) as Array<{ name: string }>;
    expect(inserted.name).toBe("B 계정 이름");
    expect(inserted.name).not.toBe("A 비공개 이름");
    expect(inserted.name).not.toBe("로컬 전용 이름");
  });
});

describe("기기 설정 인벤토리 계정 격리", () => {
  it("설정 목록 공유 선택을 계정별로 분리하고 저장 전에는 활성화하지 않는다", () => {
    const storage = new MemoryStorage();
    writeInventorySyncPreference("scope\nuser-a", true, storage);

    expect(readInventorySyncPreference("scope\nuser-a", storage)).toBe(true);
    expect(hasInventorySyncPreference("scope\nuser-a", storage)).toBe(true);
    expect(readInventorySyncPreference("scope\nuser-b", storage)).toBe(false);
    expect(hasInventorySyncPreference("scope\nuser-b", storage)).toBe(false);
    writeInventorySyncPreference("scope\nuser-b", false, storage);
    expect(readInventorySyncPreference("scope\nuser-b", storage)).toBe(false);
    expect(hasInventorySyncPreference("scope\nuser-b", storage)).toBe(true);
    expect(readInventorySyncPreference(undefined, storage)).toBe(false);
  });

  it("로그인 화면에서 확인한 메타데이터 공유 동의는 한 번만 소비한다", () => {
    const storage = new MemoryStorage();

    markInventoryLoginConsent(storage);

    expect(consumeInventoryLoginConsent(storage)).toBe(true);
    expect(consumeInventoryLoginConsent(storage)).toBe(false);
  });

  it("로컬 전용 선택은 진행 중 인증 상태와 동의를 지우고 콜백 세대를 무효화한다", () => {
    const authStorage = new MemoryStorage();
    const consentStorage = new MemoryStorage();
    authStorage.setItem("token-deck-auth-state", "pending-state");
    authStorage.setItem("token-deck-auth-pkce-verifier", "pending-verifier");
    authStorage.setItem("unrelated", "preserved");
    markInventoryLoginConsent(consentStorage);
    const authAttemptGeneration = { current: 7 };
    const accountGeneration = { current: 11 };

    cancelPendingAuthAttempt(authAttemptGeneration, accountGeneration, authStorage, consentStorage);

    expect(authAttemptGeneration.current).toBe(8);
    expect(accountGeneration.current).toBe(12);
    expect(authStorage.getItem("token-deck-auth-state")).toBeNull();
    expect(authStorage.getItem("token-deck-auth-pkce-verifier")).toBeNull();
    expect(authStorage.getItem("unrelated")).toBe("preserved");
    expect(consumeInventoryLoginConsent(consentStorage)).toBe(false);
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
  it("Windows 자격 증명에는 짧은 새로고침 토큰만 저장한다", async () => {
    const scope = "https://example.supabase.co\nsb_publishable_test";
    const session = {
      accessToken: "a".repeat(2_000),
      refreshToken: "refresh-token",
      expiresAt: 1_800_000_000,
      userId: "user-a",
    };
    const compact = compactSessionForStorage(session);
    const stored = JSON.stringify({ scope, session: compact, marker: "m".repeat(36) });

    expect(compact).toEqual({ accessToken: "", refreshToken: "refresh-token", userId: "user-a" });
    expect(stored.length * 2).toBeLessThanOrEqual(2_560);
    await expect(loadStoredSession(scope, new MemoryStorage(), async () => stored)).resolves.toEqual(compact);
    expect(() => compactSessionForStorage({ accessToken: "access-only" })).toThrow("새로고침 토큰");
  });

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

  it("운영 모드에서는 저장된 서버보다 빌드 기본 Supabase 설정을 우선한다", () => {
    const buildDefault = { url: "https://build.supabase.co", anonKey: "sb_publishable_build" };
    expect(resolveSupabaseConfig(null, buildDefault)).toEqual(buildDefault);
    expect(resolveSupabaseConfig({ url: "https://saved.supabase.co", anonKey: "sb_publishable_saved" }, buildDefault))
      .toEqual(buildDefault);
    expect(resolveSupabaseConfig({ url: "https://saved.supabase.co", anonKey: "sb_publishable_saved" }, buildDefault, true))
      .toEqual({ url: "https://saved.supabase.co", anonKey: "sb_publishable_saved" });
  });

  it("운영 서버 전환 시 이전 서버의 레거시 인증 상태를 함께 제거한다", () => {
    const storage = {
      getItem: vi.fn((key: string) => key === "token-deck-supabase-config" ? "{}" : null),
      removeItem: vi.fn(),
    };

    expect(clearProductionSupabaseOverride(storage, false)).toBe(true);

    expect(storage.removeItem.mock.calls.map(([key]) => key)).toEqual([
      "token-deck-supabase-session",
      "token-deck-auth-state",
      "token-deck-auth-pkce-verifier",
      "token-deck-supabase-config",
    ]);
  });

  it("원격 요청이 멈추면 제한 시간 뒤 로컬 정리를 계속할 수 있다", async () => {
    vi.useFakeTimers();
    try {
      const abort = vi.fn();
      const pending = settleWithin(new Promise<void>(() => undefined), 2_000, abort);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toEqual({ status: "timed_out" });
      expect(abort).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("레거시 인증 정리가 중단되면 설정 표식을 남겨 다음 시작에 재시도한다", () => {
    const removed: string[] = [];
    const storage = {
      getItem: vi.fn(() => "{}"),
      removeItem: vi.fn((key: string) => {
        if (key === "token-deck-auth-state") throw new Error("storage unavailable");
        removed.push(key);
      }),
    };

    expect(clearProductionSupabaseOverride(storage, false)).toBe(false);

    expect(removed).toEqual(["token-deck-supabase-session"]);
    expect(storage.removeItem).not.toHaveBeenCalledWith("token-deck-supabase-config");
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
