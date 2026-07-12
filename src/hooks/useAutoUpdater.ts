// 앱 실행과 온라인 복구 시 업데이트를 확인하고 장주기로 다시 확인하는 React 훅
import { useEffect, useState } from "react";
import { revealUpdatePrompt } from "../platform/update-prompt";
import {
  INITIAL_APP_UPDATE_STATE,
  isMissingUpdateMetadataError,
  runAppUpdateFlow,
  type AppUpdateInfo,
  type AppUpdateState,
  type UpdateFlowOptions,
} from "../services/updater";

export const APP_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export interface UseAutoUpdaterOptions {
  enabled?: boolean;
  confirmUpdate?(update: AppUpdateInfo): boolean | Promise<boolean>;
}

export interface AutoUpdateMonitorRuntime {
  runFlow(options: UpdateFlowOptions): Promise<AppUpdateState>;
  revealPrompt(): Promise<void>;
  setInterval(callback: () => void, milliseconds: number): number;
  clearInterval(id: number): void;
  addOnlineListener(callback: () => void): void;
  removeOnlineListener(callback: () => void): void;
}

export interface AutoUpdateMonitorOptions {
  confirmUpdate(update: AppUpdateInfo): boolean | Promise<boolean>;
  onState(state: AppUpdateState): void;
  runtime: AutoUpdateMonitorRuntime;
  intervalMs?: number;
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

function failedState(error: unknown): AppUpdateState {
  if (isMissingUpdateMetadataError(error)) {
    return { ...INITIAL_APP_UPDATE_STATE, phase: "metadata-missing" };
  }
  return { ...INITIAL_APP_UPDATE_STATE, phase: "error", error: errorMessage(error) };
}

export class AutoUpdateMonitor {
  private confirmUpdate: AutoUpdateMonitorOptions["confirmUpdate"];
  private readonly onState: AutoUpdateMonitorOptions["onState"];
  private readonly runtime: AutoUpdateMonitorRuntime;
  private readonly intervalMs: number;
  private readonly declinedVersions = new Set<string>();
  private readonly handleOnline = () => { void this.check(); };
  private intervalId: number | null = null;
  private inFlight: Promise<AppUpdateState> | null = null;

  constructor(options: AutoUpdateMonitorOptions) {
    this.confirmUpdate = options.confirmUpdate;
    this.onState = options.onState;
    this.runtime = options.runtime;
    this.intervalMs = options.intervalMs ?? APP_UPDATE_CHECK_INTERVAL_MS;
  }

  setConfirmUpdate(confirmUpdate: AutoUpdateMonitorOptions["confirmUpdate"]): void {
    this.confirmUpdate = confirmUpdate;
  }

  start(): void {
    if (this.intervalId !== null) return;
    void this.check();
    this.runtime.addOnlineListener(this.handleOnline);
    this.intervalId = this.runtime.setInterval(() => { void this.check(); }, this.intervalMs);
  }

  stop(): void {
    if (this.intervalId === null) return;
    this.runtime.clearInterval(this.intervalId);
    this.runtime.removeOnlineListener(this.handleOnline);
    this.intervalId = null;
  }

  check(): Promise<AppUpdateState> {
    if (this.inFlight) return this.inFlight;

    const task = Promise.resolve()
      .then(() => this.runtime.runFlow({
        confirmUpdate: async (update) => {
          if (this.declinedVersions.has(update.version)) return false;
          await this.runtime.revealPrompt();
          const accepted = await this.confirmUpdate(update);
          if (!accepted) this.declinedVersions.add(update.version);
          return accepted;
        },
        onState: this.onState,
      }))
      .catch((error) => {
        const failed = failedState(error);
        this.onState(failed);
        return failed;
      })
      .finally(() => {
        if (this.inFlight === task) this.inFlight = null;
      });

    this.inFlight = task;
    return task;
  }
}

let latestState = INITIAL_APP_UPDATE_STATE;
let monitor: AutoUpdateMonitor | null = null;
let enabledHookCount = 0;
const subscribers = new Set<(state: AppUpdateState) => void>();

function publish(state: AppUpdateState): void {
  latestState = state;
  for (const subscriber of subscribers) subscriber(state);
}

function browserRuntime(): AutoUpdateMonitorRuntime {
  return {
    runFlow: runAppUpdateFlow,
    revealPrompt: revealUpdatePrompt,
    setInterval: (callback, milliseconds) => window.setInterval(callback, milliseconds),
    clearInterval: (id) => window.clearInterval(id),
    addOnlineListener: (callback) => window.addEventListener("online", callback),
    removeOnlineListener: (callback) => window.removeEventListener("online", callback),
  };
}

function enableMonitor(confirmUpdate: AutoUpdateMonitorOptions["confirmUpdate"]): void {
  monitor ??= new AutoUpdateMonitor({ confirmUpdate, onState: publish, runtime: browserRuntime() });
  monitor.setConfirmUpdate(confirmUpdate);
  enabledHookCount += 1;
  if (enabledHookCount === 1) monitor.start();
}

function disableMonitor(): void {
  enabledHookCount = Math.max(0, enabledHookCount - 1);
  if (enabledHookCount === 0) monitor?.stop();
}

export function useAutoUpdater(options: UseAutoUpdaterOptions = {}): AppUpdateState {
  const { enabled = true, confirmUpdate = defaultConfirm } = options;
  const [state, setState] = useState(latestState);

  useEffect(() => {
    subscribers.add(setState);
    setState(latestState);
    if (enabled) enableMonitor(confirmUpdate);
    return () => {
      subscribers.delete(setState);
      if (enabled) disableMonitor();
    };
  }, [enabled, confirmUpdate]);

  return state;
}
