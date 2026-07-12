// 앱 시작 시 업데이트를 한 번 확인하고 사용자 동의 후 설치하는 React 훅
import { useEffect, useState } from "react";
import {
  INITIAL_APP_UPDATE_STATE,
  runAppUpdateFlow,
  type AppUpdateInfo,
  type AppUpdateState,
} from "../services/updater";

export interface UseAutoUpdaterOptions {
  enabled?: boolean;
  confirmUpdate?(update: AppUpdateInfo): boolean | Promise<boolean>;
}

let startupTask: Promise<AppUpdateState> | null = null;
let startupState = INITIAL_APP_UPDATE_STATE;
const subscribers = new Set<(state: AppUpdateState) => void>();

function publish(state: AppUpdateState): void {
  startupState = state;
  for (const subscriber of subscribers) subscriber(state);
}

function defaultConfirm(update: AppUpdateInfo): boolean {
  return window.confirm(
    `Token Deck ${update.version} 버전이 나왔습니다.\n` +
    `현재 버전은 ${update.currentVersion}입니다.\n\n` +
    "지금 다운로드하고 설치하시겠습니까?",
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function startOnce(confirmUpdate: (update: AppUpdateInfo) => boolean | Promise<boolean>): void {
  if (startupTask) return;
  startupTask = runAppUpdateFlow({ confirmUpdate, onState: publish })
    .catch((error) => {
      const failed: AppUpdateState = {
        ...startupState,
        phase: "error",
        error: errorMessage(error),
      };
      publish(failed);
      return failed;
    });
}

export function useAutoUpdater(options: UseAutoUpdaterOptions = {}): AppUpdateState {
  const { enabled = true, confirmUpdate = defaultConfirm } = options;
  const [state, setState] = useState(startupState);

  useEffect(() => {
    subscribers.add(setState);
    setState(startupState);
    if (enabled) startOnce(confirmUpdate);
    return () => {
      subscribers.delete(setState);
    };
  }, [enabled, confirmUpdate]);

  return state;
}
