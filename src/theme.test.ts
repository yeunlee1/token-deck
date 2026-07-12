// 테마 저장값 검증과 문서 루트 초기 적용을 검증한다.
import { describe, expect, it, vi } from "vitest";
import { applyTheme, DEFAULT_THEME, readTheme, storeTheme, THEME_OPTIONS, THEME_STORAGE_KEY } from "./theme";

describe("theme preferences", () => {
  it("요청된 여섯 가지 테마를 중복 없이 제공한다", () => {
    expect(THEME_OPTIONS).toHaveLength(6);
    expect(new Set(THEME_OPTIONS.map((theme) => theme.id)).size).toBe(6);
    expect(THEME_OPTIONS.map((theme) => theme.id)).toEqual(["dark", "spring", "summer", "autumn", "winter", "modern-blue"]);
  });

  it("저장값이 없거나 손상되면 모던 블루를 기본값으로 사용한다", () => {
    expect(readTheme({ getItem: vi.fn(() => null) })).toBe(DEFAULT_THEME);
    expect(readTheme({ getItem: vi.fn(() => "unknown") })).toBe("modern-blue");
    expect(readTheme({ getItem: vi.fn(() => { throw new Error("storage unavailable"); }) })).toBe("modern-blue");
  });

  it("정상적으로 저장된 계절 테마를 그대로 복원한다", () => {
    expect(readTheme({ getItem: vi.fn(() => "autumn") })).toBe("autumn");
  });

  it("선택 테마를 저장하고 문서 루트의 색상 체계를 함께 적용한다", () => {
    const storage = { setItem: vi.fn() };
    const root = { dataset: {} as DOMStringMap, style: { colorScheme: "" } as CSSStyleDeclaration };

    storeTheme("dark", storage);
    applyTheme("dark", root);

    expect(storage.setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "dark");
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });
});
