// 현재 기기 이름과 선택 공급사 수집 명령이 안전하게 연결되는지 검증한다
import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fallbackDeviceName, getCurrentDeviceInfo, getIntegrationStatus, scanLocalUsage, setCollectionProviders } from "./tauri";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => {
  vi.mocked(invoke).mockReset();
  vi.unstubAllGlobals();
});

describe("current device info bridge", () => {
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
    vi.mocked(invoke).mockResolvedValueOnce([]).mockResolvedValueOnce({ codex: true, claude: false, gemini: false }).mockResolvedValueOnce(undefined);

    await scanLocalUsage(["codex"], 456);
    await getIntegrationStatus(["codex"]);
    await setCollectionProviders(["codex"]);

    expect(invoke).toHaveBeenNthCalledWith(1, "scan_local_usage", { modifiedSince: 456, providers: ["codex"] });
    expect(invoke).toHaveBeenNthCalledWith(2, "integration_status", { providers: ["codex"] });
    expect(invoke).toHaveBeenNthCalledWith(3, "set_collection_providers", { providers: ["codex"] });
  });
});
