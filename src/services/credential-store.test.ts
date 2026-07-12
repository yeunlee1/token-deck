// 공급사 자격 증명이 Supabase 계정 소유자별로 격리되는지 검증하는 테스트
import { describe, expect, it } from "vitest";
import { decodeOwnedProviderSecret, encodeOwnedProviderSecret, ownedProviderKey } from "./credential-store";

describe("owned provider credentials", () => {
  it("저장한 소유자에게만 공급사 자격 증명을 반환한다", () => {
    const stored = encodeOwnedProviderSecret("scope\nuser-a", JSON.stringify({ adminApiKey: "secret-a" }), "marker-a");

    expect(decodeOwnedProviderSecret(stored, "scope\nuser-a")).toEqual({
      version: 1,
      owner: "scope\nuser-a",
      secret: JSON.stringify({ adminApiKey: "secret-a" }),
      marker: "marker-a",
    });
    expect(decodeOwnedProviderSecret(stored, "scope\nuser-b")).toBeUndefined();
  });

  it("소유자 정보가 없는 기존 저장 형식은 로그인 계정에 자동 연결하지 않는다", () => {
    const legacy = JSON.stringify({ adminApiKey: "legacy-secret" });

    expect(decodeOwnedProviderSecret(legacy, "scope\nuser-a")).toBeUndefined();
  });

  it("같은 공급사라도 계정 소유자별 Credential Manager 슬롯을 분리한다", () => {
    const keyA = ownedProviderKey("openai", "scope\nuser-a");
    const keyB = ownedProviderKey("openai", "scope\nuser-b");

    expect(keyA).toMatch(/^openai:[0-9a-f]{16}$/);
    expect(keyB).toMatch(/^openai:[0-9a-f]{16}$/);
    expect(keyA).not.toBe(keyB);
  });
});
