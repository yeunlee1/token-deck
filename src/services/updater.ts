// Tauri 업데이트 확인부터 서명된 설치와 앱 재실행까지 담당하는 서비스
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";

export interface AppUpdateInfo {
  currentVersion: string;
  version: string;
  date: string | null;
  body: string | null;
}

export type AppUpdatePhase =
  | "idle"
  | "unsupported"
  | "checking"
  | "current"
  | "metadata-missing"
  | "available"
  | "declined"
  | "downloading"
  | "installing"
  | "relaunching"
  | "error";

export interface AppUpdateState {
  phase: AppUpdatePhase;
  update: AppUpdateInfo | null;
  downloadedBytes: number;
  totalBytes: number | null;
  error: string | null;
}

export interface UpdateHandle {
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
  downloadAndInstall(onEvent?: (event: DownloadEvent) => void): Promise<void>;
  close(): Promise<void>;
}

export interface UpdateAdapter {
  check(): Promise<UpdateHandle | null>;
  relaunch(): Promise<void>;
}

export interface UpdateFlowOptions {
  confirmUpdate(update: AppUpdateInfo): boolean | Promise<boolean>;
  onState?(state: AppUpdateState): void;
}

export const INITIAL_APP_UPDATE_STATE: AppUpdateState = {
  phase: "idle",
  update: null,
  downloadedBytes: 0,
  totalBytes: null,
  error: null,
};

export class UpdateCheckError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "UpdateCheckError";
  }
}

function explicitHttpStatus(error: unknown): number | null {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { status?: unknown; statusCode?: unknown; message?: unknown };
    for (const value of [candidate.status, candidate.statusCode]) {
      if (typeof value === "number" && Number.isInteger(value)) return value;
      if (typeof value === "string" && /^\d{3}$/.test(value.trim())) return Number(value);
    }
    if (typeof candidate.message === "string") return explicitHttpStatus(candidate.message);
  }
  if (typeof error !== "string") return null;
  const match = error.match(/(?:http(?:\s+status)?|status(?:\s+code)?|상태(?:\s+코드)?)\s*[:=]?\s*(\d{3})\b/i);
  return match ? Number(match[1]) : null;
}

export function isMissingUpdateMetadataError(error: unknown): boolean {
  if (!(error instanceof UpdateCheckError)) return false;
  return explicitHttpStatus(error.cause) === 404 || explicitHttpStatus(error.message) === 404;
}

const tauriAdapter: UpdateAdapter = {
  check: () => check({ timeout: 15_000 }) as Promise<Update | null>,
  relaunch,
};

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function updateInfo(update: UpdateHandle): AppUpdateInfo {
  return {
    currentVersion: update.currentVersion,
    version: update.version,
    date: update.date ?? null,
    body: update.body ?? null,
  };
}

function state(
  phase: AppUpdatePhase,
  update: AppUpdateInfo | null,
  downloadedBytes = 0,
  totalBytes: number | null = null,
): AppUpdateState {
  return { phase, update, downloadedBytes, totalBytes, error: null };
}

async function closeQuietly(update: UpdateHandle): Promise<void> {
  try {
    await update.close();
  } catch {
    // 업데이트 리소스 정리 실패는 사용자의 선택이나 원래 설치 오류를 덮어쓰지 않습니다.
  }
}

export async function executeUpdateFlow(
  adapter: UpdateAdapter,
  options: UpdateFlowOptions,
): Promise<AppUpdateState> {
  const publish = (next: AppUpdateState) => {
    options.onState?.(next);
    return next;
  };

  publish(state("checking", null));
  let update: UpdateHandle | null;
  try {
    update = await adapter.check();
  } catch (error) {
    throw new UpdateCheckError(error);
  }
  if (!update) return publish(state("current", null));

  const info = updateInfo(update);
  publish(state("available", info));

  let accepted: boolean;
  try {
    accepted = await options.confirmUpdate(info);
  } catch (error) {
    await closeQuietly(update);
    throw error;
  }

  if (!accepted) {
    await closeQuietly(update);
    return publish(state("declined", info));
  }

  let downloadedBytes = 0;
  let totalBytes: number | null = null;
  publish(state("downloading", info, downloadedBytes, totalBytes));

  try {
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        totalBytes = event.data.contentLength ?? null;
      } else if (event.event === "Progress") {
        downloadedBytes += event.data.chunkLength;
      }
      publish(state(
        event.event === "Finished" ? "installing" : "downloading",
        info,
        downloadedBytes,
        totalBytes,
      ));
    });
  } catch (error) {
    await closeQuietly(update);
    throw error;
  }

  await closeQuietly(update);
  publish(state("relaunching", info, downloadedBytes, totalBytes));
  await adapter.relaunch();
  return state("relaunching", info, downloadedBytes, totalBytes);
}

export async function runAppUpdateFlow(options: UpdateFlowOptions): Promise<AppUpdateState> {
  if (!isTauriRuntime()) {
    const unsupported = state("unsupported", null);
    options.onState?.(unsupported);
    return unsupported;
  }
  return executeUpdateFlow(tauriAdapter, options);
}
