// Supabase 사용 이벤트의 비활성화와 멱등 업서트를 검증하는 테스트
import { describe, expect, it, vi } from "vitest";
import { SupabaseRestClient } from "./client";
import { UsageSyncService } from "./sync";

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
    expect(request.mock.calls[1][0]).toContain("/sessions?on_conflict=user_id,id");
    expect(request.mock.calls[2][0]).toContain("/usage_events?on_conflict=user_id,event_id");
    expect(JSON.parse(String((request.mock.calls[2][1] as RequestInit).body))[0]).toEqual(expect.objectContaining({
      project_id: "git_project-hash",
      session_id: expect.stringMatching(/^session_[0-9a-f]{64}$/),
    }));
    expect(String((request.mock.calls[1][1] as RequestInit).body)).not.toContain("session-external");
    expect(String((request.mock.calls[2][1] as RequestInit).body)).not.toContain("session-external");
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
