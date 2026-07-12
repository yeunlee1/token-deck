// 여섯 가지 앱 테마의 메타데이터와 저장·초기 적용 규칙을 관리한다.
export type ThemeId = "dark" | "spring" | "summer" | "autumn" | "winter" | "modern-blue";

export interface ThemeOption {
  id: ThemeId;
  label: string;
  season: string;
  description: string;
  swatches: readonly [string, string, string];
  colorScheme: "light" | "dark";
}

export const THEME_STORAGE_KEY = "token-deck-theme";
export const DEFAULT_THEME: ThemeId = "modern-blue";

export const THEME_OPTIONS: readonly ThemeOption[] = [
  { id: "dark", label: "다크", season: "MIDNIGHT", description: "짙은 네이비와 아이스 블루", swatches: ["#0b111c", "#182335", "#80d8ff"], colorScheme: "dark" },
  { id: "spring", label: "봄", season: "BLOSSOM", description: "벚꽃 핑크와 어린잎 그린", swatches: ["#f4f3ee", "#fbe8ed", "#f0a0b6"], colorScheme: "light" },
  { id: "summer", label: "여름", season: "TIDE", description: "맑은 바다와 청록빛 파도", swatches: ["#edf6f5", "#e2f4f7", "#56c7d2"], colorScheme: "light" },
  { id: "autumn", label: "가을", season: "HARVEST", description: "크림 종이와 호박빛 오렌지", swatches: ["#f5f0e7", "#f8e7d2", "#e3a24b"], colorScheme: "light" },
  { id: "winter", label: "겨울", season: "FROST", description: "서리 화이트와 차가운 블루", swatches: ["#eef3f7", "#e2effc", "#9bc7f0"], colorScheme: "light" },
  { id: "modern-blue", label: "모던 블루", season: "MOBILITY", description: "정밀한 화이트 패널과 선명한 블루", swatches: ["#f2f6fa", "#ffffff", "#006db7"], colorScheme: "light" },
] as const;

export function isThemeId(value: unknown): value is ThemeId {
  return THEME_OPTIONS.some((theme) => theme.id === value);
}

export function readTheme(storage: Pick<Storage, "getItem"> = window.localStorage): ThemeId {
  try {
    const saved = storage.getItem(THEME_STORAGE_KEY);
    return isThemeId(saved) ? saved : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function storeTheme(theme: ThemeId, storage: Pick<Storage, "setItem"> = window.localStorage): void {
  try { storage.setItem(THEME_STORAGE_KEY, theme); } catch { /* 로컬 저장이 막혀도 현재 화면 테마는 유지한다. */ }
}

export function applyTheme(
  theme: ThemeId,
  root: Pick<HTMLElement, "dataset" | "style"> = document.documentElement,
): void {
  const option = THEME_OPTIONS.find((item) => item.id === theme) ?? THEME_OPTIONS[THEME_OPTIONS.length - 1];
  root.dataset.theme = option.id;
  root.style.colorScheme = option.colorScheme;
}
