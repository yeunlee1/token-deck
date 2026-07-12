// 최초 실행 화면에서 세 가지 시작 경로와 접근 가능한 안내를 제공하는지 검증한다
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OnboardingScreen } from "./OnboardingScreen";

describe("OnboardingScreen", () => {
  it("Google, 이메일, 로컬 전용 시작 경로를 모두 보여준다", () => {
    const markup = renderToStaticMarkup(<OnboardingScreen authEnabled onSignInWithGoogle={vi.fn()} onSendMagicLink={vi.fn()} onContinueLocal={vi.fn()} />);

    expect(markup).toContain("Google로 계속하기");
    expect(markup).toContain("로그인 링크 받기");
    expect(markup).toContain("로그인 없이 로컬 전용으로 시작");
    expect(markup).toContain('aria-live="polite"');
    expect(markup).not.toContain("운영 동기화 서버가 연결되면");
  });

  it("동기화 서버가 없으면 원격 로그인만 비활성화한다", () => {
    const markup = renderToStaticMarkup(<OnboardingScreen authEnabled={false} onSignInWithGoogle={vi.fn()} onSendMagicLink={vi.fn()} onContinueLocal={vi.fn()} />);

    expect(markup).toContain("운영 동기화 서버가 연결되면");
    expect(markup).toMatch(/google-login-button[^>]*disabled/);
    expect(markup).toContain("로그인 없이 로컬 전용으로 시작");
  });
});
