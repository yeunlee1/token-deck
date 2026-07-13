// Supabase 사용 이벤트의 비활성화와 멱등 업서트를 검증하는 테스트
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { DeviceInventoryItem, DeviceInventorySnapshot } from "../types";
import { SupabaseRequestError, SupabaseRestClient } from "./client";
import {
  createDeviceInventorySnapshot,
  deviceInventoryContentHash,
  isDeviceInventoryTableMissingError,
  UsageSyncService,
} from "./sync";

describe("UsageSyncService", () => {
  it("환경 설정이 없으면 네트워크 호출 없이 비활성 상태를 반환한다", async () => {
    const request = vi.fn();
    const service = new UsageSyncService(new SupabaseRestClient(null, request));

    await expect(service.upsertUsageEvents([event()])).resolves.toEqual({ uploaded: 0, disabled: true });
    expect(request).not.toHaveBeenCalled();
  });

  it("이벤트 ID 복합 키를 사용해 멱등 업서트한다", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new SupabaseRestClient({ url: "https://example.supabase.co", anonKey: "anon" }, request);
    client.setSession({ accessToken: "access" });

    const result = await new UsageSyncService(client).upsertUsageEvents([event()]);

    expect(result).toEqual({ uploaded: 1, disabled: false });
    expect(request.mock.calls[0][0]).toContain("on_conflict=user_id,event_id");
    const init = request.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("Prefer")).toContain("resolution=merge-duplicates");
    expect(new Headers(init.headers).get("Prefer")).toContain("return=minimal");
    expect(JSON.parse(String(init.body))).toEqual([expect.objectContaining({ event_id: "event-1" })]);
  });

  it("프로젝트와 세션을 먼저 업서트한 뒤 세션 원본 식별자는 해시 FK로 보존한다", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new SupabaseRestClient({ url: "https://example.supabase.co", anonKey: "anon" }, request);
    client.setSession({ accessToken: "access" });
    const item = { ...event(), projectId: "git_project-hash", sessionId: "session-external" };

    await new UsageSyncService(client).upsertUsageEvents([item]);

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[0][0]).toContain("/projects?on_conflict=user_id,id");
    expect(new Headers((request.mock.calls[0][1] as RequestInit).headers).get("Prefer")).toContain("resolution=ignore-duplicates");
    expect(request.mock.calls[1][0]).toContain("/sessions?on_conflict=user_id,id");
    expect(request.mock.calls[2][0]).toContain("/usage_events?on_conflict=user_id,event_id");
    expect(JSON.parse(String((request.mock.calls[2][1] as RequestInit).body))[0]).toEqual(expect.objectContaining({
      project_id: "git_project-hash",
      session_id: expect.stringMatching(/^session_[0-9a-f]{64}$/),
    }));
    expect(String((request.mock.calls[1][1] as RequestInit).body)).not.toContain("session-external");
    expect(String((request.mock.calls[2][1] as RequestInit).body)).not.toContain("session-external");
  });

  it("선택한 프로젝트 표시명은 신규 행에 넣되 기존 계정 이름은 덮지 않는다", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new SupabaseRestClient({ url: "https://example.supabase.co", anonKey: "anon" }, request);
    client.setSession({ accessToken: "access" });
    const namedProjectId = `git_${"a".repeat(64)}`;
    const unnamedProjectId = `local_${"b".repeat(64)}`;

    await new UsageSyncService(client).upsertUsageEvents([
      { ...event(), eventId: "named", projectId: namedProjectId },
      { ...event(), eventId: "unnamed", projectId: unnamedProjectId },
    ], { [namedProjectId]: "  토큰 덱  " });

    const projectCalls = request.mock.calls.filter(([url]) => String(url).includes("/rest/v1/projects?"));
    expect(projectCalls).toHaveLength(1);
    expect(new Headers((projectCalls[0][1] as RequestInit).headers).get("Prefer")).toContain("resolution=ignore-duplicates");
    expect(JSON.parse(String((projectCalls[0][1] as RequestInit).body))).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: unnamedProjectId, name: `프로젝트 ${"b".repeat(8)}` }),
      expect.objectContaining({ id: namedProjectId, name: "토큰 덱" }),
    ]));
  });

  it("나중 기기의 일반 프로젝트 이름이 기존 명시 이름을 덮지 않는다", async () => {
    let storedName: string | undefined;
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/rest/v1/projects?")) {
        const [row] = JSON.parse(String(init?.body)) as Array<{ name: string }>;
        const prefer = new Headers(init?.headers).get("Prefer") ?? "";
        if (!storedName || prefer.includes("merge-duplicates")) storedName = row.name;
      }
      return new Response(null, { status: 204 });
    });
    const client = new SupabaseRestClient({ url: "https://example.supabase.co", anonKey: "anon" }, request);
    client.setSession({ accessToken: "access" });
    const projectId = `git_${"f".repeat(64)}`;
    const service = new UsageSyncService(client);

    await service.upsertUsageEvents([{ ...event(), eventId: "explicit", projectId }], { [projectId]: "사용자 이름" });
    await service.upsertUsageEvents([{ ...event(), eventId: "fallback", projectId }]);

    expect(storedName).toBe("사용자 이름");
  });

  it("비어 있거나 80자를 넘는 표시명은 일반 이름으로만 신규 삽입한다", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new SupabaseRestClient({ url: "https://example.supabase.co", anonKey: "anon" }, request);
    client.setSession({ accessToken: "access" });
    const emptyNameId = `project_${"c".repeat(64)}`;
    const longNameId = `provider_${"d".repeat(64)}`;

    await new UsageSyncService(client).upsertUsageEvents([
      { ...event(), eventId: "empty", projectId: emptyNameId },
      { ...event(), eventId: "long", projectId: longNameId },
    ], { [emptyNameId]: "   ", [longNameId]: "가".repeat(81) });

    const projectCall = request.mock.calls.find(([url]) => String(url).includes("/rest/v1/projects?"));
    expect(new Headers((projectCall?.[1] as RequestInit).headers).get("Prefer")).toContain("resolution=ignore-duplicates");
    expect(JSON.parse(String((projectCall?.[1] as RequestInit).body))).toEqual([
      expect.objectContaining({ id: emptyNameId, name: `프로젝트 ${"c".repeat(8)}` }),
      expect.objectContaining({ id: longNameId, name: `프로젝트 ${"d".repeat(8)}` }),
    ]);
  });

  it("다른 기기의 클라우드 이벤트와 원본 프로젝트 식별자를 내려받는다", async () => {
    const row = {
      event_id: "event-remote", provider: "claude", source: "local_session", device_id: "device-2",
      session_id: "session-2", project_id: "git_shared", occurred_at: "2026-07-11T01:00:00.000Z",
      input_tokens: 9, cached_tokens: 2, output_tokens: 4, reasoning_tokens: 0, tool_tokens: 1,
      metadata: { externalProjectId: "git_shared" }, created_at: "2026-07-11T01:01:00.000Z",
    };
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify([row]), { status: 200 }));
    const client = new SupabaseRestClient({ url: "https://example.supabase.co", anonKey: "anon" }, request);
    client.setSession({ accessToken: "access" });

    const result = await new UsageSyncService(client).listUsageEvents();

    expect(result).toEqual([expect.objectContaining({ eventId: "event-remote", deviceId: "device-2", projectId: "git_shared", inputTokens: 9, createdAt: "2026-07-11T01:01:00.000Z" })]);
    expect(request.mock.calls[0][0]).toContain("usage_events?select=");
    expect(request.mock.calls[0][0]).not.toContain("device_id=neq.");
  });

  it("created_at 커서 이후 이벤트 중 현재 물리 기기만 제외해 증분 요청한다", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    const client = new SupabaseRestClient({ url: "https://example.supabase.co", anonKey: "anon" }, request);
    client.setSession({ accessToken: "access" });

    await new UsageSyncService(client).listUsageEvents(
      "2026-07-11T01:01:00.000Z",
      "00000000-0000-0000-0000-000000000001",
    );

    const url = String(request.mock.calls[0][0]);
    expect(url).toContain("created_at=gte.2026-07-11T01%3A01%3A00.000Z");
    expect(url).toContain("device_id=neq.00000000-0000-0000-0000-000000000001");
    expect(url).toContain("order=created_at.asc,event_id.asc");
    expect(url).toContain("metadata,created_at");
  });

  it("A 조회 뒤 B가 삽입하고 A가 업로드해도 다음 증분 조회에서 B와 계정 집계를 받는다", async () => {
    const physicalDeviceId = "00000000-0000-0000-0000-000000000001";
    const accountDeviceId = "00000000-0000-4000-8000-000000000001";
    const storedRows: Array<Record<string, unknown>> = [
      row({ event_id: "own-seed", device_id: physicalDeviceId, created_at: "2026-07-11T00:00:00.000Z" }),
      row({ event_id: "account-seed", device_id: accountDeviceId, source: "provider_api", created_at: "2026-07-11T00:00:00.000Z" }),
    ];
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "POST") {
        const uploaded = JSON.parse(String(init.body)) as Array<Record<string, unknown>>;
        storedRows.push(...uploaded.map((item) => ({ ...item, created_at: "2026-07-11T00:00:02.000Z" })));
        return new Response(null, { status: 204 });
      }
      const createdAt = url.searchParams.get("created_at")?.replace(/^gte\./, "");
      const excludedDeviceId = url.searchParams.get("device_id")?.replace(/^neq\./, "");
      const selected = storedRows.filter((item) => (!createdAt || String(item.created_at) >= createdAt)
        && (!excludedDeviceId || item.device_id !== excludedDeviceId));
      return new Response(JSON.stringify(selected), { status: 200 });
    });
    const client = new SupabaseRestClient({ url: "https://example.supabase.co", anonKey: "anon" }, request);
    client.setSession({ accessToken: "access" });
    const service = new UsageSyncService(client);

    const fullSeed = await service.listUsageEvents();
    storedRows.push(row({ event_id: "remote-r", device_id: "00000000-0000-0000-0000-000000000002", created_at: "2026-07-11T00:00:01.000Z" }));
    const upload = await service.upsertUsageEvents([{ ...event(), eventId: "local-l" }]);
    const incremental = await service.listUsageEvents("2026-07-11T00:00:00.000Z", physicalDeviceId);

    expect(fullSeed.map((item) => item.eventId)).toEqual(["own-seed", "account-seed"]);
    expect(upload).toEqual({ uploaded: 1, disabled: false });
    expect(incremental.map((item) => item.eventId)).toEqual(["account-seed", "remote-r"]);
  });

  it("1,201개 프로젝트와 세션 참조를 요청당 최대 500개로 분할한다", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new SupabaseRestClient({ url: "https://example.supabase.co", anonKey: "anon" }, request);
    client.setSession({ accessToken: "access" });
    const events = Array.from({ length: 1_201 }, (_, index) => ({
      ...event(),
      eventId: `event-${index}`,
      projectId: `git_project-${index}`,
      sessionId: `session-${index}`,
    }));

    await expect(new UsageSyncService(client).upsertUsageEvents(events)).resolves.toEqual({ uploaded: 1_201, disabled: false });

    for (const resource of ["projects", "sessions", "usage_events"]) {
      const sizes = request.mock.calls
        .filter(([url]) => String(url).includes(`/rest/v1/${resource}?`))
        .map(([, init]) => (JSON.parse(String((init as RequestInit).body)) as unknown[]).length);
      expect(sizes).toEqual([500, 500, 201]);
      expect(sizes.every((size) => size <= 500)).toBe(true);
    }
  });

  it("1000행 Range 페이지를 반복해 1001개 이벤트를 모두 내려받는다", async () => {
    const base = {
      provider: "codex", source: "local_session", device_id: "device-2", session_id: null, project_id: null,
      occurred_at: "2026-07-11T01:00:00.000Z", input_tokens: 1, cached_tokens: 0, output_tokens: 0,
      reasoning_tokens: 0, tool_tokens: 0, metadata: {},
    };
    const firstPage = Array.from({ length: 1000 }, (_, index) => ({ ...base, event_id: `event-${index}` }));
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(firstPage), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ ...base, event_id: "event-1000" }]), { status: 200 }));
    const client = new SupabaseRestClient({ url: "https://example.supabase.co", anonKey: "anon" }, request);
    client.setSession({ accessToken: "access" });

    const result = await new UsageSyncService(client).listUsageEvents();

    expect(result).toHaveLength(1001);
    expect(new Headers((request.mock.calls[0][1] as RequestInit).headers).get("Range")).toBe("0-999");
    expect(new Headers((request.mock.calls[1][1] as RequestInit).headers).get("Range")).toBe("1000-1999");
  });

  it("계정 기기를 최근 접속 순서로 요청하고 앱 형식으로 변환한다", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify([{
      id: "device-2", name: "노트북", platform: "windows", app_version: "0.2.0", last_seen_at: "2026-07-11T02:00:00Z",
    }]), { status: 200 }));
    const client = new SupabaseRestClient({ url: "https://example.supabase.co", anonKey: "anon" }, request);
    client.setSession({ accessToken: "access" });

    await expect(new UsageSyncService(client).listDevices()).resolves.toEqual([{
      id: "device-2", name: "노트북", platform: "windows", appVersion: "0.2.0", lastSeenAt: "2026-07-11T02:00:00Z",
    }]);
    expect(request.mock.calls[0][0]).toContain("order=last_seen_at.desc");
  });

  it("계정 프로젝트를 조회해 표시명과 익명 식별자를 앱 형식으로 변환한다", async () => {
    const projectId = `git_${"a".repeat(64)}`;
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify([{
      id: projectId,
      name: "토큰 덱",
      git_remote_hash: projectId,
      local_project_hash: null,
      created_at: "2026-07-11T02:00:00Z",
    }]), { status: 200 }));
    const client = new SupabaseRestClient({ url: "https://example.supabase.co", anonKey: "anon" }, request);
    client.setSession({ accessToken: "access" });

    await expect(new UsageSyncService(client).listProjects()).resolves.toEqual([{
      id: projectId,
      name: "토큰 덱",
      gitRemoteHash: projectId,
      createdAt: "2026-07-11T02:00:00Z",
    }]);
    expect(request.mock.calls[0][0]).toContain("projects?select=id,name,git_remote_hash,local_project_hash,created_at");
    expect(new Headers((request.mock.calls[0][1] as RequestInit).headers).get("Range")).toBe("0-999");
  });

  it("사용자 프로젝트 이름을 소유 계정 행에만 PATCH한다", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new SupabaseRestClient({ url: "https://example.supabase.co", anonKey: "anon" }, request);
    client.setSession({ accessToken: "access" });
    const projectId = `project_${"e".repeat(64)}`;

    await expect(new UsageSyncService(client).updateProjectName(projectId, "  회사 프로젝트  "))
      .resolves.toEqual({ uploaded: 1, disabled: false });

    expect(request.mock.calls[0][0]).toContain(`/projects?id=eq.${projectId}`);
    expect((request.mock.calls[0][1] as RequestInit).method).toBe("PATCH");
    expect(JSON.parse(String((request.mock.calls[0][1] as RequestInit).body))).toEqual({ name: "회사 프로젝트" });
    expect(new Headers((request.mock.calls[0][1] as RequestInit).headers).get("Prefer")).toBe("return=minimal");
  });

  it("잘못된 사용자 프로젝트 이름은 네트워크 요청 전에 거부한다", async () => {
    const request = vi.fn();
    const client = new SupabaseRestClient({ url: "https://example.supabase.co", anonKey: "anon" }, request);
    client.setSession({ accessToken: "access" });
    const service = new UsageSyncService(client);

    await expect(service.updateProjectName("project-1", "   ")).resolves.toEqual(expect.objectContaining({
      uploaded: 0,
      disabled: false,
      error: expect.stringContaining("1자 이상 80자 이하"),
    }));
    expect(request).not.toHaveBeenCalled();
  });
});

describe("기기 설정 인벤토리 동기화", () => {
  it("허용 목록 밖의 경로·명령·토큰·환경 변수 값을 POST 본문에서 제거한다", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new SupabaseRestClient({ url: "https://example.supabase.co", anonKey: "anon" }, request);
    client.setSession({ accessToken: "access" });
    const unsafe = {
      ...inventoryItem(),
      absolutePath: "C:\\Users\\admin\\.codex\\config.toml",
      command: "npx --token super-secret",
      args: ["--api-key", "super-secret"],
      token: "super-secret",
      env: { OPENAI_API_KEY: "super-secret" },
    } as unknown as DeviceInventoryItem;
    const snapshot: DeviceInventorySnapshot = {
      deviceId: "00000000-0000-0000-0000-000000000001",
      schemaVersion: 1,
      capturedAt: Date.parse("2026-07-12T00:00:00.000Z"),
      contentHash: "0".repeat(64),
      items: [unsafe],
    };

    await expect(new UsageSyncService(client).upsertDeviceInventorySnapshot(snapshot))
      .resolves.toEqual({ uploaded: 1, disabled: false });

    const body = JSON.parse(String((request.mock.calls[0][1] as RequestInit).body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("user_id");
    expect(body.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.items).toEqual([inventoryItem()]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("config.toml");
    expect(serialized).not.toContain('"command"');
    expect(serialized).not.toContain('"args"');
    expect(serialized).not.toContain('"env"');
  });

  it("네이티브 인벤토리를 결정적 해시의 스냅샷으로 만들고 DB 행을 밀리초 시간으로 복원한다", async () => {
    const capturedAt = Date.parse("2026-07-12T01:02:03.000Z");
    const inventory = {
      schemaVersion: 1 as const,
      capturedAt,
      items: [inventoryItem({ key: "plugin-z" }), inventoryItem({ key: "plugin-a" })],
      warnings: ["codex-plugin-list-unavailable"],
    };
    const snapshot = createDeviceInventorySnapshot("00000000-0000-0000-0000-000000000001", inventory);
    const reversedHash = deviceInventoryContentHash([...inventory.items].reverse());
    let storedRow: Record<string, unknown> | undefined;
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        storedRow = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify([storedRow]), { status: 200 });
    });
    const client = new SupabaseRestClient({ url: "https://example.supabase.co", anonKey: "anon" }, request);
    client.setSession({ accessToken: "access" });
    const service = new UsageSyncService(client);

    expect(snapshot.contentHash).toBe(reversedHash);
    await expect(service.upsertDeviceInventorySnapshot(snapshot)).resolves.toEqual({ uploaded: 1, disabled: false });
    const restored = await service.listDeviceInventorySnapshots();

    expect(storedRow?.captured_at).toBe("2026-07-12T01:02:03.000Z");
    expect(storedRow).not.toHaveProperty("warnings");
    expect(restored).toEqual([expect.objectContaining({
      deviceId: snapshot.deviceId,
      schemaVersion: 1,
      capturedAt,
      contentHash: snapshot.contentHash,
      items: snapshot.items,
      updatedAt: expect.any(Number),
    })]);
  });

  it("1000행 Range 페이지를 반복해 모든 기기 스냅샷을 내려받는다", async () => {
    const item = inventoryItem();
    const contentHash = deviceInventoryContentHash([item]);
    const rowFor = (index: number) => ({
      device_id: `device-${index}`,
      schema_version: 1,
      content_hash: contentHash,
      captured_at: "2026-07-12T00:00:00.000Z",
      items: [item],
      updated_at: "2026-07-12T00:01:00.000Z",
    });
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(Array.from({ length: 1000 }, (_, index) => rowFor(index))), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([rowFor(1000)]), { status: 200 }));
    const client = new SupabaseRestClient({ url: "https://example.supabase.co", anonKey: "anon" }, request);
    client.setSession({ accessToken: "access" });

    const result = await new UsageSyncService(client).listDeviceInventorySnapshots();

    expect(result).toHaveLength(1001);
    expect(new Headers((request.mock.calls[0][1] as RequestInit).headers).get("Range")).toBe("0-999");
    expect(new Headers((request.mock.calls[1][1] as RequestInit).headers).get("Range")).toBe("1000-1999");
  });

  it("기기 스냅샷 테이블이 schema cache에 없다는 오류만 구분한다", () => {
    const missing = new SupabaseRequestError("Supabase 요청 실패 (404)", 404, {
      code: "PGRST205",
      message: "Could not find the table 'public.device_setting_snapshots' in the schema cache",
    });
    const anotherTable = new SupabaseRequestError("Supabase 요청 실패 (404)", 404, {
      code: "PGRST205",
      message: "Could not find the table 'public.other_table' in the schema cache",
    });

    expect(isDeviceInventoryTableMissingError(missing)).toBe(true);
    expect(isDeviceInventoryTableMissingError(anotherTable)).toBe(false);
    expect(isDeviceInventoryTableMissingError("PGRST205 device_setting_snapshots schema cache"))
      .toBe(true);
  });

  it("migration이 복합 계정 키와 RLS 및 최소 권한을 선언한다", () => {
    const sql = readFileSync(
      new URL("../../../supabase/migrations/202607120001_device_setting_snapshots.sql", import.meta.url),
      "utf8",
    ).toLowerCase();

    expect(sql).toContain("primary key (user_id, device_id)");
    expect(sql).toContain("foreign key (user_id, device_id) references public.devices(user_id, id)");
    expect(sql).toContain("enable row level security");
    expect(sql.match(/auth\.uid\(\) = user_id/g)).toHaveLength(4);
    expect(sql).toContain("revoke all on public.device_setting_snapshots from anon, authenticated");
    expect(sql).toContain("grant select, insert, update on public.device_setting_snapshots to authenticated");
    expect(sql).not.toContain("grant select, insert, update, delete");
    expect(sql).toContain("jsonb_array_length(items) <= 512");
    expect(sql).toContain("octet_length(items::text) <= 524288");
  });
});

function event() {
  return {
    eventId: "event-1",
    provider: "codex" as const,
    source: "local_session" as const,
    deviceId: "00000000-0000-0000-0000-000000000001",
    occurredAt: "2026-07-11T00:00:00.000Z",
    inputTokens: 10,
    cachedTokens: 2,
    outputTokens: 3,
    reasoningTokens: 1,
    toolTokens: 0,
  };
}

function inventoryItem(overrides: Partial<DeviceInventoryItem> = {}): DeviceInventoryItem {
  return {
    provider: "codex",
    kind: "plugin",
    key: "plugin-openai-example",
    displayName: "OpenAI Example",
    version: "1.2.3",
    enabled: true,
    installed: true,
    source: "marketplace",
    marketplace: "openai/example",
    hasSecrets: false,
    transferable: true,
    ...overrides,
  };
}

function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    event_id: "event-remote",
    provider: "codex",
    source: "local_session",
    device_id: "00000000-0000-0000-0000-000000000002",
    session_id: null,
    project_id: null,
    model: null,
    occurred_at: "2026-07-11T00:00:00.000Z",
    input_tokens: 1,
    cached_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    tool_tokens: 0,
    session_title: null,
    metadata: {},
    created_at: "2026-07-11T00:00:00.000Z",
    ...overrides,
  };
}
