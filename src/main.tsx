// 데스크톱 대시보드 React 애플리케이션 진입점
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initializeDurableDeviceId, restoreDurableCollectionProviders } from "./platform/tauri";
import { applyTheme, readTheme } from "./theme";
import "./styles.css";

applyTheme(readTheme());

async function startApplication(): Promise<void> {
  await Promise.all([
    initializeDurableDeviceId(),
    restoreDurableCollectionProviders(),
  ]);
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void startApplication().catch((cause: unknown) => {
  const root = document.getElementById("root");
  if (!root) return;
  root.setAttribute("role", "alert");
  root.textContent = cause instanceof Error
    ? `로컬 기기 설정을 복구하지 못해 앱을 시작하지 않았습니다. ${cause.message}`
    : "로컬 기기 설정을 복구하지 못해 앱을 시작하지 않았습니다.";
});
