// 로그인 화면으로 복귀할 때 인증과 온보딩 상태를 안전한 순서로 정리한다
export const ONBOARDING_COMPLETE_KEY = "token-deck-onboarding-complete";

export type LoginAuthStatus = "local" | "signed_out" | "authenticated";

export async function prepareLoginScreen(
  authStatus: LoginAuthStatus,
  signOut: () => Promise<void> | void,
  storage: Pick<Storage, "removeItem">,
): Promise<void> {
  if (authStatus === "authenticated") await signOut();
  storage.removeItem(ONBOARDING_COMPLETE_KEY);
}
