// Windows 자동 시작과 Gemini 텔레메트리 상태를 화면에 연결하는 React 훅
import { useCallback, useEffect, useState } from "react";
import {
  configureGeminiTelemetry,
  getAutostartStatus,
  getGeminiStatus,
  setAutostart,
  type AutostartStatus,
  type GeminiStatus,
} from "../platform/native";

const EMPTY_AUTOSTART: AutostartStatus = { supported: false, enabled: false, launchCommand: null };
const EMPTY_GEMINI: GeminiStatus = { installed: false, version: null, executablePath: null, settingsPath: "", settingsExists: false, telemetryConfigured: false, telemetryOutfile: "" };

export function useNativeSettings() {
  const [autostart, setAutostartState] = useState(EMPTY_AUTOSTART);
  const [gemini, setGemini] = useState(EMPTY_GEMINI);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const refresh = useCallback(async () => {
    try {
      const [autostartStatus, geminiStatus] = await Promise.all([getAutostartStatus(), getGeminiStatus()]);
      setAutostartState(autostartStatus);
      setGemini(geminiStatus);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "네이티브 설정을 확인하지 못했습니다.");
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const toggleAutostart = useCallback(async (enabled: boolean) => {
    setBusy(true);
    try {
      setAutostartState(await setAutostart(enabled));
      setMessage(enabled ? "Windows 로그인 시 백그라운드로 시작합니다." : "자동 시작을 해제했습니다.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "자동 시작 설정을 변경하지 못했습니다.");
    } finally { setBusy(false); }
  }, []);
  const enableGeminiTelemetry = useCallback(async () => {
    setBusy(true);
    try {
      const result = await configureGeminiTelemetry();
      setMessage(result.backupPath ? "기존 Gemini 설정을 백업하고 안전 수집을 활성화했습니다." : "Gemini 안전 수집을 활성화했습니다.");
      setGemini(await getGeminiStatus());
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Gemini 수집 설정을 변경하지 못했습니다.");
    } finally { setBusy(false); }
  }, []);
  return { autostart, gemini, busy, message, refresh, toggleAutostart, enableGeminiTelemetry };
}
