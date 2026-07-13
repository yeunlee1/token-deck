// 운영 설정 화면에서 서버 입력을 숨기고 로그인 화면 복귀 경로를 제공하는지 검증한다
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsPanel";

type SettingsProps = ComponentProps<typeof SettingsPanel>;

function renderSettings(
  auth: SettingsProps["auth"],
  allowSupabaseOverride = false,
  overrides: Partial<SettingsProps> = {},
): string {
  const asyncAction = vi.fn(async () => undefined);
  const props: SettingsProps = {
    open: true,
    auth,
    cloudSync: { status: "signed_out", uploaded: 0, pending: 0 },
    credentials: {
      openai: { configured: false, checking: false },
      anthropic: { configured: false, checking: false },
      google: { configured: false, checking: false },
    },
    gemini: {
      installed: false,
      version: null,
      executablePath: null,
      settingsPath: "",
      settingsExists: false,
      telemetryConfigured: false,
      telemetryOutfile: "",
    },
    autostart: { supported: false, enabled: false, launchCommand: null },
    nativeBusy: false,
    nativeMessage: "",
    providerUsage: [],
    sessions: [],
    enabledProviders: ["codex", "claude", "gemini"],
    miniTotalVisible: true,
    miniTotalPeriod: "오늘",
    inventorySyncEnabled: false,
    inventorySyncBusy: false,
    claudeQuotaCapture: { configured: false, hasData: false, existingStatusLine: false },
    quotaBusy: false,
    theme: "modern-blue",
    allowSupabaseOverride,
    onClose: vi.fn(),
    onConfigureSupabase: asyncAction,
    onClearSupabaseConfig: asyncAction,
    onReturnToLogin: asyncAction,
    onSaveCredential: asyncAction,
    onRemoveCredential: asyncAction,
    onRefreshProvider: asyncAction,
    onUpdateSessionTitle: asyncAction,
    onSetAutostart: asyncAction,
    onConfigureGemini: asyncAction,
    onToggleProvider: vi.fn(),
    onToggleMiniTotal: vi.fn(),
    onSelectTheme: vi.fn(),
    onConfigureClaudeQuota: asyncAction,
    onSetInventorySyncEnabled: asyncAction,
    ...overrides,
  };

  return renderToStaticMarkup(<SettingsPanel {...props} />);
}

describe("SettingsPanel 계정 진입 경로", () => {
  it("운영 화면에서는 Supabase 서버 입력을 숨기고 로그인 화면 복귀 버튼만 제공한다", () => {
    const markup = renderSettings({ enabled: true, status: "signed_out" });

    expect(markup).toContain("로그인 화면으로 돌아가기");
    expect(markup).toContain('type="button"');
    expect(markup).not.toContain("Supabase 서버 연결");
    expect(markup).not.toContain("Project URL");
    expect(markup).not.toContain("Publishable key");
    expect(markup).not.toContain("Google로 로그인");
    expect(markup).not.toContain("로그인 링크 받기");
  });

  it("인증된 계정에는 로그아웃을 알리는 로그인 화면 복귀 버튼을 제공한다", () => {
    const markup = renderSettings({ enabled: true, status: "authenticated", userId: "user-1" });

    expect(markup).toContain("동기화 계정 연결됨");
    expect(markup).toContain("로그아웃하고 로그인 화면으로");
    expect(markup).toContain("이동하면 현재 계정에서 로그아웃됩니다");
  });

  it("개발 모드에서만 Supabase 서버 덮어쓰기 입력을 표시한다", () => {
    const markup = renderSettings({ enabled: true, status: "signed_out" }, true);

    expect(markup).toContain("Supabase 서버 연결");
    expect(markup).toContain("Project URL");
    expect(markup).toContain("Publishable key");
  });

  it("여섯 가지 테마와 현재 선택 상태를 접근 가능한 단일 선택으로 표시한다", () => {
    const markup = renderSettings({ enabled: true, status: "signed_out" });

    expect((markup.match(/data-theme-id=/g) ?? [])).toHaveLength(6);
    expect(markup).toContain("다크");
    expect(markup).toContain("봄");
    expect(markup).toContain("여름");
    expect(markup).toContain("가을");
    expect(markup).toContain("겨울");
    expect(markup).toContain("모던 블루");
    expect((markup.match(/type="radio"/g) ?? [])).toHaveLength(6);
    expect((markup.match(/checked=""/g) ?? [])).toHaveLength(1);
  });

  it("세 인공지능 서비스를 실제 수집 대상으로 선택할 수 있게 표시한다", () => {
    const markup = renderSettings({ enabled: true, status: "signed_out" });

    expect(markup).toContain("수집할 AI 서비스");
    expect(markup).toContain("OpenAI Codex");
    expect(markup).toContain("Claude");
    expect(markup).toContain("Gemini");
    expect((markup.match(/aria-pressed="true"/g) ?? [])).toHaveLength(3);
    expect(markup).toContain("선택한 서비스만 새 로컬 로그와 잔여 한도를 읽고 계정에 동기화");
  });

  it("코덱스만 선택하면 Claude와 Gemini의 추가 수집 설정을 숨긴다", () => {
    const markup = renderSettings(
      { enabled: true, status: "signed_out" },
      false,
      { enabledProviders: ["codex"] },
    );

    expect((markup.match(/aria-pressed="true"/g) ?? [])).toHaveLength(1);
    expect((markup.match(/aria-pressed="false"/g) ?? [])).toHaveLength(2);
    expect((markup.match(/class="credential-form"/g) ?? [])).toHaveLength(3);
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain("Gemini 해제 중 해당 파일을 읽거나 동기화하지 않습니다");
    expect(markup).not.toContain("Claude 한도 연동이 꺼져 있습니다");
    expect(markup).not.toContain("Gemini CLI 수집");
  });
});
