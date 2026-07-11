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
    expect(JSON.parse(String(init.body))).toEqual([expect.objectContaining({ event_id: "event-1" })]);
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
