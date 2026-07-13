// 기기 설정 비교가 안전한 플러그인만 선택하고 개인정보 안내를 유지하는지 검증한다
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DeviceInventory, DeviceInventoryItem, DeviceInventorySnapshot, DeviceRegistration } from "../services/types";
import { buildDeviceToolkitSummaries, buildInventoryComparison, DeviceInventoryPanel, summarizeInventoryApplyResults } from "./DeviceInventoryPanel";

function inventoryItem(overrides: Partial<DeviceInventoryItem> = {}): DeviceInventoryItem {
  return {
    provider: "codex",
    kind: "plugin",
    key: "plugin-a@market",
    displayName: "플러그인 A",
    version: "1.0.0",
    enabled: true,
    installed: true,
    source: "marketplace",
    marketplace: "market",
    hasSecrets: false,
    transferable: true,
    ...overrides,
  };
}

const devices: DeviceRegistration[] = [
  { id: "current-device", name: "업무용 PC", platform: "Windows", appVersion: "0.3.0", lastSeenAt: "2026-07-12T00:00:00Z" },
  { id: "remote-device", name: "노트북", platform: "Windows", appVersion: "0.3.0", lastSeenAt: "2026-07-12T01:00:00Z" },
];

const localInventory: DeviceInventory = {
  schemaVersion: 1,
  capturedAt: Date.parse("2026-07-12T00:00:00Z"),
  items: [inventoryItem()],
  warnings: [],
};

const snapshots: DeviceInventorySnapshot[] = [{
  deviceId: "remote-device",
  schemaVersion: 1,
  capturedAt: Date.parse("2026-07-12T01:00:00Z"),
  contentHash: "snapshot-hash",
  items: [
    inventoryItem(),
    inventoryItem({ key: "plugin-b@market", displayName: "플러그인 B", version: "2.0.0" }),
    inventoryItem({ kind: "skill", key: "review-skill", displayName: "리뷰 스킬", transferable: false, source: "user" }),
    inventoryItem({ kind: "mcp", key: "private-mcp", displayName: "사내 MCP", hasSecrets: true, transferable: false, blockedReason: "secret", transport: "stdio", source: "user" }),
  ],
}];

describe("DeviceInventoryPanel", () => {
  it("같은 버전은 이미 있음으로 표시하고 안전한 플러그인만 가져오기 가능으로 분류한다", () => {
    const comparison = buildInventoryComparison(snapshots[0].items, localInventory.items);

    expect(comparison.map((entry) => [entry.item.displayName, entry.status])).toEqual([
      ["플러그인 A", "installed"],
      ["플러그인 B", "transferable"],
      ["리뷰 스킬", "manual"],
      ["사내 MCP", "manual"],
    ]);
    expect(comparison.find((entry) => entry.item.displayName === "사내 MCP")?.reason).toContain("비밀 값");
  });

  it("같은 버전의 플러그인이 비활성화되어 있으면 다시 활성화할 수 있게 선택한다", () => {
    const comparison = buildInventoryComparison(
      [inventoryItem()],
      [inventoryItem({ enabled: false })],
    );

    expect(comparison[0].status).toBe("transferable");
    expect(comparison[0].reason).toBe("현재 기기에 설치되어 있어 활성화할 수 있습니다.");
  });

  it("같은 플러그인의 버전만 다르면 자동 업데이트 대상으로 오인하지 않는다", () => {
    const comparison = buildInventoryComparison(
      [inventoryItem({ version: "2.0.0" })],
      [inventoryItem({ version: "1.0.0" })],
    );

    expect(comparison[0].status).toBe("installed");
    expect(comparison[0].reason).toContain("자동 버전 맞춤은 지원하지 않습니다.");
  });

  it("대상 기기에 없는 Gemini 확장과 원본에서 꺼진 플러그인은 자동 설치하지 않는다", () => {
    const comparison = buildInventoryComparison([
      inventoryItem({ provider: "gemini", key: "gemini-extension" }),
      inventoryItem({ key: "disabled-plugin", enabled: false }),
    ], []);

    expect(comparison.map((entry) => entry.status)).toEqual(["manual", "manual"]);
    expect(comparison[1].reason).toContain("비활성화");
  });

  it("원격 플러그인 ID와 마켓플레이스 메타데이터가 일치하지 않으면 선택을 막는다", () => {
    const comparison = buildInventoryComparison([
      inventoryItem({ key: "plugin-a@market", marketplace: "different" }),
      inventoryItem({ key: "plugin-without-marketplace", marketplace: undefined }),
      inventoryItem({ source: "user" }),
      inventoryItem({ key: `${"a".repeat(120)}@${"b".repeat(20)}`, marketplace: "b".repeat(20) }),
    ], []);

    expect(comparison.map((entry) => entry.status)).toEqual(["manual", "manual", "manual", "manual"]);
  });

  it("가져오기 결과에서 실제 적용, 이미 설치됨과 실패를 따로 집계한다", () => {
    const summary = summarizeInventoryApplyResults([
      { key: "a", status: "applied", message: "적용됨" },
      { key: "b", status: "alreadyPresent", message: "이미 있음" },
      { key: "c", status: "failed", message: "설치 실패" },
      { key: "d", status: "manual", message: "직접 설정 필요" },
    ]);

    expect(summary.resultMessage).toBe("1개 적용 · 1개 이미 설치됨");
    expect(summary.errorMessage).toBe("2개를 적용하지 못했습니다. 설치 실패 직접 설정 필요");
  });

  it("등록 기기마다 마지막 스킬·MCP·플러그인 현황을 분리해 집계한다", () => {
    const summaries = buildDeviceToolkitSummaries(devices, snapshots, "current-device", localInventory);

    expect(summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ deviceId: "current-device", current: true, plugins: 1, itemCount: 1 }),
      expect.objectContaining({ deviceId: "remote-device", current: false, skills: 1, mcps: 1, plugins: 2, itemCount: 4 }),
    ]));
  });

  it("원본과 현재 기기, 종류 필터, 상태와 접근성 메시지를 렌더링한다", () => {
    const markup = renderToStaticMarkup(<DeviceInventoryPanel devices={devices} currentDeviceId="current-device" snapshots={snapshots} localInventory={localInventory} syncEnabled loading={false} error="원격 목록 오류" onEnableSync={vi.fn()} onRefresh={vi.fn()} onApply={vi.fn().mockResolvedValue([])} />);
    const installedInput = markup.match(/<input[^>]*aria-label="플러그인 A 이미 있음"[^>]*>/)?.[0] ?? "";
    const transferableInput = markup.match(/<input[^>]*aria-label="플러그인 B 가져오기 가능"[^>]*>/)?.[0] ?? "";

    expect(markup).toContain("기기 설정 비교");
    expect(markup).toContain("노트북");
    expect(markup).toContain("업무용 PC");
    expect(markup).toContain('aria-label="설정 종류 필터"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("원격 목록 오류");
    expect(installedInput).toContain("disabled");
    expect(transferableInput).not.toContain("disabled");
  });

  it("현재 기기 업로드가 꺼져 있어도 계정에 저장된 다른 기기 목록을 보여준다", () => {
    const markup = renderToStaticMarkup(<DeviceInventoryPanel devices={devices} currentDeviceId="current-device" snapshots={snapshots} localInventory={localInventory} syncEnabled={false} loading={false} onEnableSync={vi.fn()} onRefresh={vi.fn()} onApply={vi.fn().mockResolvedValue([])} />);

    expect(markup).toContain("이 기기의 새 목록 업로드가 꺼져 있습니다.");
    expect(markup).toContain("기기 식별자, 목록 스키마 버전, 수집·갱신 시각, 내용 비교용 해시");
    expect(markup).toContain("수집 출처 분류");
    expect(markup).toContain("마켓플레이스 식별자");
    expect(markup).toContain("자동 가져오기 가능 여부와 제한 사유 분류");
    expect(markup).toContain("비밀값, 명령, 제한 사유의 원문과 전체 경로는 전송하지 않으며");
    expect(markup).toContain("목록 동기화 켜기");
    expect(markup).toContain("업무용 PC에서 감지");
    expect(markup).toContain("플러그인 A");
    expect(markup).toContain("노트북");
    expect(markup).toContain("기기별 전역 도구 현황");
    expect(markup).toContain("선택 항목 검토");
  });
});
