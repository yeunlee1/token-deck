// 기기별 AI 도구 인벤토리를 Tauri 네이티브 수집기와 연결하는 어댑터
import { invoke } from "@tauri-apps/api/core";
import type { DeviceInventory, DeviceInventoryItem } from "../services";

export type DeviceInventoryApplyStatus = "applied" | "alreadyPresent" | "manual" | "failed";

export interface DeviceInventoryApplyResult {
  key: string;
  status: DeviceInventoryApplyStatus;
  message: string;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function collectDeviceInventory(): Promise<DeviceInventory> {
  if (!isTauriRuntime()) {
    return { schemaVersion: 1, capturedAt: Date.now(), items: [], warnings: ["기기 설정 목록은 데스크톱 앱에서 확인할 수 있습니다."] };
  }
  return invoke<DeviceInventory>("collect_device_inventory");
}

export async function applyDeviceInventoryItems(items: DeviceInventoryItem[]): Promise<DeviceInventoryApplyResult[]> {
  if (!isTauriRuntime()) throw new Error("기기 설정 가져오기는 데스크톱 앱에서만 사용할 수 있습니다.");
  return invoke<DeviceInventoryApplyResult[]>("apply_device_inventory_items", { items });
}
