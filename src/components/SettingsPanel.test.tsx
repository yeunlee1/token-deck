// 운영 설정 화면에서 서버 입력을 숨기고 로그인 화면 복귀 경로를 제공하는지 검증한다
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsPanel";

type SettingsProps = ComponentProps<typeof SettingsPanel>;

function renderSettings(auth: SettingsProps["auth"], allowSupabaseOverride = false): string {
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
    displayProviders: ["codex", "claude", "gemini"],
    miniTotalVisible: true,
    miniTotalPeriod: "오늘",
    inventorySyncEnabled: false,
    inventorySyncBusy: false,
    claudeQuotaCapture: { configured: false, hasData: false, existingStatusLine: false },
    quotaBusy: false,
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
    onToggleDisplayProvider: vi.fn(),
    onToggleMiniTotal: vi.fn(),
    onConfigureClaudeQuota: asyncAction,
    onSetInventorySyncEnabled: asyncAction,
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
});
