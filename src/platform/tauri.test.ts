// 현재 기기 이름과 선택 공급사 수집 명령이 안전하게 연결되는지 검증한다
import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commitScanCursors, fallbackDeviceName, getCurrentDeviceInfo, getIntegrationStatus, initializeDurableDeviceId, loadLocalProjectNames, loadLocalUsageCache, loadLocalUsageState, restoreDurableCollectionProviders, saveLocalProjectNames, saveLocalUsageCache, saveLocalUsageState, scanLocalUsage, setCollectionProviders } from "./tauri";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => {
  vi.mocked(invoke).mockReset();
  vi.unstubAllGlobals();
});

describe("current device info bridge", () => {
  it("웹뷰 저장소가 초기화돼도 네이티브 수집 서비스 선택을 복원한다", async () => {
    const values = new Map<string, string>();
    const localStorage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, localStorage });
    vi.mocked(invoke).mockResolvedValueOnce(["codex"]);

    await expect(restoreDurableCollectionProviders()).resolves.toEqual(["codex"]);

    expect(invoke).toHaveBeenCalledWith("load_collection_providers");
    expect(values.get("token-deck-collection-providers")).toBe('["codex"]');
  });

  it("네이티브 수집 서비스 설정이 없으면 기존 웹뷰 선택을 덮어쓰지 않는다", async () => {
    const localStorage = { getItem: vi.fn(), setItem: vi.fn() };
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, localStorage });
    vi.mocked(invoke).mockResolvedValueOnce(null);

    await expect(restoreDurableCollectionProviders()).resolves.toBeNull();

    expect(localStorage.setItem).not.toHaveBeenCalled();
  });

  it("기존 웹뷰 기기 ID를 최초 네이티브 저장 후보로 그대로 전달한다", async () => {
    const values = new Map([["token-deck-device-id", "00000000-0000-4000-8000-000000000001"]]);
    const localStorage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, localStorage });
    vi.mocked(invoke).mockResolvedValueOnce("00000000-0000-4000-8000-000000000001");

    await expect(initializeDurableDeviceId()).resolves.toBe("00000000-0000-4000-8000-000000000001");

    expect(invoke).toHaveBeenCalledWith("load_or_store_device_id", {
      candidate: "00000000-0000-4000-8000-000000000001",
    });
    expect(localStorage.setItem).toHaveBeenCalledWith(
      "token-deck-device-id",
      "00000000-0000-4000-8000-000000000001",
    );
  });

  it("웹뷰 저장소가 초기화되면 새 후보 대신 네이티브 기기 ID를 복구한다", async () => {
    const values = new Map<string, string>();
    const localStorage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, localStorage });
    vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000099" });
    vi.mocked(invoke).mockResolvedValueOnce("00000000-0000-4000-8000-000000000001");

    await expect(initializeDurableDeviceId()).resolves.toBe("00000000-0000-4000-8000-000000000001");

    expect(invoke).toHaveBeenCalledWith("load_or_store_device_id", {
      candidate: "00000000-0000-4000-8000-000000000099",
    });
    expect(values.get("token-deck-device-id")).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("웹뷰의 비 UUID 오염값은 네이티브 저장 후보로 사용하지 않는다", async () => {
    const localStorage = {
      getItem: vi.fn(() => "abc"),
      setItem: vi.fn(),
    };
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, localStorage });
    vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000099" });
    vi.mocked(invoke).mockResolvedValueOnce("00000000-0000-4000-8000-000000000099");

    await initializeDurableDeviceId();

    expect(invoke).toHaveBeenCalledWith("load_or_store_device_id", {
      candidate: "00000000-0000-4000-8000-000000000099",
    });
  });

  it("네이티브 저장소가 잘못된 ID를 반환하면 웹뷰 값을 덮어쓰지 않는다", async () => {
    const localStorage = {
      getItem: vi.fn(() => "00000000-0000-4000-8000-000000000001"),
      setItem: vi.fn(),
    };
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, localStorage });
    vi.mocked(invoke).mockResolvedValueOnce("../unsafe");

    await expect(initializeDurableDeviceId()).rejects.toThrow("올바른 기기 식별자");
    expect(localStorage.setItem).not.toHaveBeenCalled();
  });

  it("기기 ID의 마지막 여섯 글자로 구분 가능한 이름을 만든다", () => {
    expect(fallbackDeviceName("12345678-abcd-4000-8000-00ab12cd34ef"))
      .toBe("Windows 기기 CD34EF");
    expect(fallbackDeviceName("---")).toBe("Windows 기기");
  });

  it("브라우저에서는 기기 ID 기반 Windows 정보를 반환한다", async () => {
    await expect(getCurrentDeviceInfo("00000000-0000-4000-8000-00000000abcd"))
      .resolves.toEqual({ name: "Windows 기기 00ABCD", platform: "windows" });
  });

  it("선택 공급사와 증분 시각을 네이티브 수집 명령에 전달한다", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.mocked(invoke)
      .mockResolvedValueOnce({ documents: [], commitToken: "scan-1" })
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce({ codex: true, claude: false, gemini: false })
      .mockResolvedValueOnce(undefined);

    await expect(scanLocalUsage(["codex"], 456)).resolves.toEqual({ documents: [], commitToken: "scan-1" });
    await expect(commitScanCursors("scan-1")).resolves.toBe(true);
    await getIntegrationStatus(["codex"]);
    await setCollectionProviders(["codex"]);

    expect(invoke).toHaveBeenNthCalledWith(1, "scan_local_usage", { modifiedSince: 456, providers: ["codex"] });
    expect(invoke).toHaveBeenNthCalledWith(2, "commit_scan_cursors", { commitToken: "scan-1" });
    expect(invoke).toHaveBeenNthCalledWith(3, "integration_status", { providers: ["codex"] });
    expect(invoke).toHaveBeenNthCalledWith(4, "set_collection_providers", { providers: ["codex"] });
  });

  it("로컬 사용량 메타데이터 캐시를 Tauri 명령으로 읽고 쓴다", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const event = {
      id: "event-1", provider: "codex" as const, source: "local-jsonl" as const,
      deviceId: "device-1", sessionId: "session-1", projectId: "project-1",
      occurredAt: "2026-07-14T00:00:00.000Z",
      tokens: { input: 1, cached: 2, output: 3, reasoning: 4, tool: 5 },
    };
    vi.mocked(invoke).mockResolvedValueOnce([event]).mockResolvedValueOnce(undefined);

    await expect(loadLocalUsageCache()).resolves.toEqual([event]);
    await saveLocalUsageCache([event]);

    expect(invoke).toHaveBeenNthCalledWith(1, "load_local_usage_cache");
    expect(invoke).toHaveBeenNthCalledWith(2, "save_local_usage_cache", { events: [event] });
  });

  it("이벤트와 계정 소유권 해시를 하나의 네이티브 상태로 읽고 쓴다", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const state = { version: 1 as const, knownEventIds: ["event-1"], owners: { "event-1": "a".repeat(64) } };
    const snapshot = {
      events: [],
      ownership: state,
      codexCumulative: {},
      codexRetiredSessionFilter: "retired-filter",
    };
    vi.mocked(invoke).mockResolvedValueOnce(snapshot).mockResolvedValueOnce(undefined);

    await expect(loadLocalUsageState()).resolves.toEqual(snapshot);
    await saveLocalUsageState([], state, {}, "retired-filter");

    expect(invoke).toHaveBeenNthCalledWith(1, "load_local_usage_state");
    expect(invoke).toHaveBeenNthCalledWith(2, "save_local_usage_state", {
      events: [],
      ownership: state,
      codexCumulative: {},
      codexRetiredSessionFilter: "retired-filter",
    });
  });

  it("자동 추론 프로젝트 이름을 사용자 지정 이름과 별도인 Tauri 캐시에 저장한다", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const names = { project_1: "Token Deck" };
    vi.mocked(invoke).mockResolvedValueOnce(names).mockResolvedValueOnce(undefined);

    await expect(loadLocalProjectNames()).resolves.toEqual(names);
    await saveLocalProjectNames(names);

    expect(invoke).toHaveBeenNthCalledWith(1, "load_local_project_names");
    expect(invoke).toHaveBeenNthCalledWith(2, "save_local_project_names", { names });
  });
});
