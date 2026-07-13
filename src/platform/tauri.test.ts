// 현재 기기 이름을 얻지 못해도 안전한 식별 이름을 만드는지 검증한다
import { describe, expect, it } from "vitest";
import { fallbackDeviceName, getCurrentDeviceInfo } from "./tauri";

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
});
