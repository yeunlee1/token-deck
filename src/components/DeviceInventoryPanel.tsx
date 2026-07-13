// 연결된 기기의 스킬·MCP·플러그인을 비교하고 안전한 항목만 현재 기기로 가져오는 패널
import { useEffect, useMemo, useState } from "react";
import type { DeviceInventory, DeviceInventoryItem, DeviceInventorySnapshot, DeviceRegistration } from "../services/types";
import type { DeviceInventoryApplyResult } from "../platform/device-inventory";
import { Icon } from "./Icon";

type InventoryCategory = "all" | DeviceInventoryItem["kind"];
export type InventoryComparisonStatus = "transferable" | "installed" | "manual";

export interface InventoryComparisonEntry {
  item: DeviceInventoryItem;
  selectionKey: string;
  status: InventoryComparisonStatus;
  reason: string;
}

export interface DeviceInventoryPanelProps {
  devices: DeviceRegistration[];
  currentDeviceId: string;
  snapshots: DeviceInventorySnapshot[];
  localInventory: DeviceInventory;
  syncEnabled: boolean;
  loading: boolean;
  error?: string;
  onEnableSync: () => Promise<void> | void;
  onRefresh: () => Promise<void> | void;
  onApply: (sourceDeviceId: string, items: DeviceInventoryItem[]) => Promise<DeviceInventoryApplyResult[]>;
}

export interface DeviceToolkitSummary {
  deviceId: string;
  name: string;
  current: boolean;
  capturedAt?: number;
  itemCount: number;
  skills: number;
  mcps: number;
  plugins: number;
  providers: DeviceInventoryItem["provider"][];
}

const categoryLabels: Record<InventoryCategory, string> = {
  all: "전체",
  skill: "스킬",
  mcp: "MCP",
  plugin: "플러그인",
};

const providerLabels: Record<DeviceInventoryItem["provider"], string> = {
  codex: "Codex",
  claude: "Claude",
  gemini: "Gemini",
};

const sourceLabels: Record<DeviceInventoryItem["source"], string> = {
  user: "사용자 설정",
  system: "시스템",
  marketplace: "마켓플레이스",
  bundled: "기본 제공",
  project: "프로젝트",
};

function selectionKey(item: DeviceInventoryItem): string {
  return [item.provider, item.kind, item.key, item.version ?? "", item.marketplace ?? ""].join("\u001f");
}

function isInstalledItem(source: DeviceInventoryItem, local: DeviceInventoryItem): boolean {
  return local.installed
    && source.provider === local.provider
    && source.kind === local.kind
    && source.key === local.key;
}

function manualReason(item: DeviceInventoryItem): string {
  if (!item.installed) return "원본 기기에 설치된 항목이 아닙니다.";
  if (!item.enabled) return "원본 기기에서 비활성화된 항목입니다.";
  if (item.hasSecrets || item.blockedReason === "secret") return "비밀 값은 동기화하지 않아 직접 설정해야 합니다.";
  if (item.blockedReason === "local_path") return "현재 기기에서 로컬 경로를 다시 지정해야 합니다.";
  if (item.blockedReason === "unsupported") return "이 설치 방식은 자동 적용을 지원하지 않습니다.";
  if (item.kind === "skill") return "스킬은 현재 목록 비교만 지원합니다.";
  if (item.kind === "mcp") return "MCP는 현재 기기에서 직접 설정해야 합니다.";
  return "지원되는 마켓플레이스 정보가 없어 직접 설치해야 합니다.";
}

function isMarketplacePluginRecipe(item: DeviceInventoryItem): boolean {
  if (item.provider === "gemini" || item.kind !== "plugin" || !item.installed || !item.enabled || !item.transferable) return false;
  if (item.hasSecrets || item.blockedReason || !item.marketplace || !["marketplace", "bundled"].includes(item.source)) return false;
  if (item.key.length > 128) return false;
  const parts = item.key.split("@");
  const validPart = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
  return parts.length === 2 && validPart(parts[0]) && validPart(parts[1]) && parts[1] === item.marketplace;
}

export function buildInventoryComparison(sourceItems: DeviceInventoryItem[], localItems: DeviceInventoryItem[]): InventoryComparisonEntry[] {
  return sourceItems.map((item) => {
    const installedLocalItem = localItems.find((local) => isInstalledItem(item, local));
    if (installedLocalItem?.enabled) {
      const sameVersion = (item.version ?? "") === (installedLocalItem.version ?? "");
      return { item, selectionKey: selectionKey(item), status: "installed", reason: sameVersion ? "현재 기기에 같은 항목이 설치되어 있습니다." : `현재 기기에 ${installedLocalItem.version ? `v${installedLocalItem.version}` : "다른 버전"}이 설치되어 있습니다. 자동 버전 맞춤은 지원하지 않습니다.` };
    }

    if (installedLocalItem && item.kind === "plugin" && item.enabled && !item.hasSecrets && !item.blockedReason && (item.provider === "gemini" || isMarketplacePluginRecipe(item))) {
      return { item, selectionKey: selectionKey(item), status: "transferable", reason: "현재 기기에 설치되어 있어 활성화할 수 있습니다." };
    }

    if (isMarketplacePluginRecipe(item)) {
      return { item, selectionKey: selectionKey(item), status: "transferable", reason: "원본 기기의 마켓플레이스 ID로 설치할 수 있습니다." };
    }

    return { item, selectionKey: selectionKey(item), status: "manual", reason: manualReason(item) };
  });
}

export function summarizeInventoryApplyResults(results: DeviceInventoryApplyResult[]): { resultMessage: string; errorMessage: string } {
  const appliedCount = results.filter((result) => result.status === "applied").length;
  const alreadyPresentCount = results.filter((result) => result.status === "alreadyPresent").length;
  const failedResults = results.filter((result) => result.status === "failed" || result.status === "manual");
  return {
    resultMessage: [appliedCount ? `${appliedCount}개 적용` : "", alreadyPresentCount ? `${alreadyPresentCount}개 이미 설치됨` : ""].filter(Boolean).join(" · "),
    errorMessage: failedResults.length ? `${failedResults.length}개를 적용하지 못했습니다. ${failedResults.map((result) => result.message).join(" ")}` : "",
  };
}

function statusLabel(status: InventoryComparisonStatus): string {
  if (status === "transferable") return "가져오기 가능";
  if (status === "installed") return "이미 있음";
  return "직접 설정 필요";
}

function formatCapturedAt(timestamp: number): string {
  return new Date(timestamp).toLocaleString("ko-KR");
}

function deviceLabel(deviceId: string, devices: DeviceRegistration[]): string {
  return devices.find((device) => device.id === deviceId)?.name ?? `기기 ${deviceId.slice(-6).toUpperCase()}`;
}

export function buildDeviceToolkitSummaries(
  devices: DeviceRegistration[],
  snapshots: DeviceInventorySnapshot[],
  currentDeviceId: string,
  localInventory: DeviceInventory,
): DeviceToolkitSummary[] {
  const latestByDevice = new Map<string, DeviceInventorySnapshot>();
  snapshots.forEach((snapshot) => {
    const current = latestByDevice.get(snapshot.deviceId);
    if (!current || (snapshot.updatedAt ?? snapshot.capturedAt) > (current.updatedAt ?? current.capturedAt)) latestByDevice.set(snapshot.deviceId, snapshot);
  });
  const deviceIds = new Set([...devices.map((device) => device.id), ...latestByDevice.keys(), currentDeviceId]);
  return [...deviceIds].map((deviceId) => {
    const current = deviceId === currentDeviceId;
    const snapshot = latestByDevice.get(deviceId);
    const items = current ? localInventory.items : snapshot?.items ?? [];
    return {
      deviceId,
      name: deviceLabel(deviceId, devices),
      current,
      capturedAt: current ? localInventory.capturedAt || undefined : snapshot?.capturedAt,
      itemCount: items.length,
      skills: items.filter((item) => item.kind === "skill").length,
      mcps: items.filter((item) => item.kind === "mcp").length,
      plugins: items.filter((item) => item.kind === "plugin").length,
      providers: [...new Set(items.map((item) => item.provider))].sort(),
    };
  }).sort((left, right) => Number(right.current) - Number(left.current) || right.itemCount - left.itemCount || left.name.localeCompare(right.name, "ko"));
}

export function DeviceInventoryPanel(props: DeviceInventoryPanelProps) {
  const remoteSnapshots = useMemo(() => {
    const latestByDevice = new Map<string, DeviceInventorySnapshot>();
    props.snapshots.forEach((snapshot) => {
      if (snapshot.deviceId === props.currentDeviceId) return;
      const current = latestByDevice.get(snapshot.deviceId);
      if (!current || (snapshot.updatedAt ?? snapshot.capturedAt) > (current.updatedAt ?? current.capturedAt)) latestByDevice.set(snapshot.deviceId, snapshot);
    });
    return [...latestByDevice.values()];
  }, [props.currentDeviceId, props.snapshots]);
  const [sourceDeviceId, setSourceDeviceId] = useState(() => remoteSnapshots[0]?.deviceId ?? "");
  const [category, setCategory] = useState<InventoryCategory>("all");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [reviewing, setReviewing] = useState(false);
  const [action, setAction] = useState<"enable" | "refresh" | "apply">();
  const [resultMessage, setResultMessage] = useState("");
  const [localError, setLocalError] = useState("");
  const sourceSnapshot = remoteSnapshots.find((snapshot) => snapshot.deviceId === sourceDeviceId);
  const comparison = useMemo(
    () => buildInventoryComparison(sourceSnapshot?.items ?? [], props.localInventory.items),
    [props.localInventory.items, sourceSnapshot],
  );
  const visibleEntries = category === "all" ? comparison : comparison.filter((entry) => entry.item.kind === category);
  const selectableKeys = useMemo(() => new Set(comparison.filter((entry) => entry.status === "transferable").map((entry) => entry.selectionKey)), [comparison]);
  const selectedEntries = comparison.filter((entry) => entry.status === "transferable" && selectedKeys.has(entry.selectionKey));
  const currentDeviceName = deviceLabel(props.currentDeviceId, props.devices);
  const toolkitSummaries = useMemo(
    () => buildDeviceToolkitSummaries(props.devices, props.snapshots, props.currentDeviceId, props.localInventory),
    [props.currentDeviceId, props.devices, props.localInventory, props.snapshots],
  );
  const busy = props.loading || Boolean(action);

  useEffect(() => {
    if (remoteSnapshots.some((snapshot) => snapshot.deviceId === sourceDeviceId)) return;
    setSourceDeviceId(remoteSnapshots[0]?.deviceId ?? "");
    setSelectedKeys(new Set());
    setReviewing(false);
  }, [remoteSnapshots, sourceDeviceId]);

  useEffect(() => {
    setSelectedKeys((current) => {
      const next = new Set([...current].filter((key) => selectableKeys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [selectableKeys]);

  useEffect(() => {
    setSelectedKeys(new Set());
    setReviewing(false);
  }, [sourceSnapshot?.contentHash]);

  function changeSource(deviceId: string) {
    setSourceDeviceId(deviceId);
    setSelectedKeys(new Set());
    setReviewing(false);
    setResultMessage("");
    setLocalError("");
  }

  function toggleItem(key: string) {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setReviewing(false);
    setResultMessage("");
  }

  async function runAction(kind: "enable" | "refresh", callback: () => Promise<void> | void) {
    setAction(kind);
    setLocalError("");
    setResultMessage("");
    try {
      await callback();
      setResultMessage(kind === "enable" ? "기기 설정 목록 동기화를 켰습니다." : "기기 설정 목록을 다시 확인했습니다.");
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : "요청을 처리하지 못했습니다.");
    } finally {
      setAction(undefined);
    }
  }

  async function applySelected() {
    if (!selectedEntries.length) return;
    setAction("apply");
    setLocalError("");
    setResultMessage("");
    try {
      const results = await props.onApply(sourceDeviceId, selectedEntries.map((entry) => entry.item));
      const summary = summarizeInventoryApplyResults(results);
      setResultMessage(summary.resultMessage);
      setLocalError(summary.errorMessage);
      setSelectedKeys(new Set());
      setReviewing(false);
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : "선택한 플러그인을 가져오지 못했습니다.");
    } finally {
      setAction(undefined);
    }
  }

  const categories = Object.keys(categoryLabels) as InventoryCategory[];
  const differenceCount = comparison.filter((entry) => entry.status !== "installed").length;
  const manualCount = comparison.filter((entry) => entry.status === "manual").length;

  return (
    <article className="panel device-inventory-panel" aria-labelledby="device-inventory-title">
      <header className="inventory-heading">
        <div><span className="eyebrow">DEVICE TOOLKIT</span><h2 id="device-inventory-title">기기 설정 비교</h2><p>다른 기기의 스킬·MCP·플러그인을 확인하고 안전한 항목만 현재 기기로 가져옵니다.</p></div>
        <button className="secondary-button inventory-refresh" type="button" disabled={busy} onClick={() => void runAction("refresh", props.onRefresh)}><Icon className={action === "refresh" ? "spin" : ""} name="refresh" />{action === "refresh" ? "확인 중…" : "목록 다시 확인"}</button>
      </header>

      <section className="toolkit-device-section" aria-labelledby="toolkit-device-title">
        <div className="toolkit-device-title"><div><strong id="toolkit-device-title">기기별 전역 도구 현황</strong><small>같은 계정에 등록된 각 기기의 마지막 스킬·MCP·플러그인 목록입니다.</small></div><span>{toolkitSummaries.length}대</span></div>
        <div className="toolkit-device-grid">{toolkitSummaries.map((summary) => <article className={`toolkit-device-card ${summary.current ? "current" : ""}`} key={summary.deviceId}>
          <div className="toolkit-device-head"><span className={`device-icon ${summary.current ? "current" : ""}`}><Icon name="device" /></span><div><strong>{summary.name}</strong><small>ID {summary.deviceId.slice(-6).toUpperCase()} · {summary.current ? "현재 기기" : summary.capturedAt ? `목록 저장 ${formatCapturedAt(summary.capturedAt)}` : "저장된 목록 없음"}</small></div></div>
          <div className="toolkit-device-counts"><span><b>{summary.skills}</b>스킬</span><span><b>{summary.mcps}</b>MCP</span><span><b>{summary.plugins}</b>플러그인</span></div>
          <div className="toolkit-device-providers">{summary.providers.length ? summary.providers.map((provider) => <span key={provider}>{providerLabels[provider]}</span>) : <span className="empty">아직 감지된 도구 없음</span>}</div>
        </article>)}</div>
      </section>

      <details className="local-inventory-details">
        <summary><span><strong>{currentDeviceName}에서 감지</strong><small>{props.localInventory.items.length}개 항목 · 스킬 {props.localInventory.items.filter((item) => item.kind === "skill").length} · MCP {props.localInventory.items.filter((item) => item.kind === "mcp").length} · 플러그인 {props.localInventory.items.filter((item) => item.kind === "plugin").length}</small></span><span>현재 목록 보기</span></summary>
        {props.localInventory.items.length ? <div className="local-inventory-list">{props.localInventory.items.map((item) => <div key={selectionKey(item)}><span className={`inventory-kind ${item.kind}`}>{categoryLabels[item.kind]}</span><span><strong>{item.displayName}</strong><small>{[providerLabels[item.provider], item.version ? `v${item.version}` : undefined, item.enabled ? "활성" : "비활성"].filter(Boolean).join(" · ")}</small></span></div>)}</div> : <p className="local-inventory-empty">{props.loading ? "현재 기기의 도구 목록을 확인하고 있습니다." : "현재 기기에서 감지된 설정 항목이 없습니다."}</p>}
        {props.localInventory.warnings.length > 0 && <p className="local-inventory-warning">안전 검사로 건너뛴 설정 위치가 {props.localInventory.warnings.length}개 있습니다.</p>}
      </details>

      {!props.syncEnabled && <div className="inventory-consent"><Icon name="lock" /><div><strong>이 기기의 새 목록 업로드가 꺼져 있습니다.</strong><p>기기 식별자, 목록 스키마 버전, 수집·갱신 시각, 내용 비교용 해시와 도구의 종류, 공급사, 항목 ID·이름, 버전, 설치·활성 상태, 수집 출처 분류, 마켓플레이스 식별자, 연결 방식, 비밀 설정 필요 여부, 자동 가져오기 가능 여부와 제한 사유 분류만 동기화합니다. 비밀값, 명령, 제한 사유의 원문과 전체 경로는 전송하지 않으며 마지막 스냅샷은 계정 비교용으로 유지됩니다.</p></div><button className="primary-button" type="button" disabled={busy} onClick={() => void runAction("enable", props.onEnableSync)}>{action === "enable" ? "켜는 중…" : "목록 동기화 켜기"}</button></div>}

      {remoteSnapshots.length === 0 ? <div className="panel-empty inventory-empty"><Icon name="device" /><strong>비교할 다른 기기 목록이 아직 없습니다.</strong><p>같은 계정으로 연결된 다른 기기에서 Token Deck을 실행하면 자동으로 표시됩니다.</p></div> : <>
        <div className="inventory-toolbar">
          <label htmlFor="inventory-source-device">가져올 원본 기기<select id="inventory-source-device" value={sourceDeviceId} onChange={(event) => changeSource(event.target.value)}>{remoteSnapshots.map((snapshot) => <option key={snapshot.deviceId} value={snapshot.deviceId}>{deviceLabel(snapshot.deviceId, props.devices)}</option>)}</select><small>{sourceSnapshot ? `최근 확인 ${formatCapturedAt(sourceSnapshot.capturedAt)}` : "목록 대기 중"}</small></label>
          <div className="inventory-direction" aria-label={`원본 기기에서 현재 기기 ${currentDeviceName}(으)로 가져오기`}><span>{sourceSnapshot ? deviceLabel(sourceSnapshot.deviceId, props.devices) : "원본 기기"}</span><Icon name="chevron" /><div><strong>{currentDeviceName}</strong><small>현재 기기</small></div></div>
        </div>

        <div className="inventory-filter" aria-label="설정 종류 필터">{categories.map((item) => <button type="button" key={item} aria-pressed={category === item} onClick={() => setCategory(item)}>{categoryLabels[item]}<span>{item === "all" ? comparison.length : comparison.filter((entry) => entry.item.kind === item).length}</span></button>)}</div>
        <div className="inventory-summary"><span><b>{differenceCount}</b>개 차이</span><span><b>{selectableKeys.size}</b>개 가져오기 가능</span><span><b>{manualCount}</b>개 직접 설정</span></div>

        <fieldset className="inventory-list" disabled={busy}>
          <legend>현재 기기와 비교한 항목</legend>
          {visibleEntries.length ? visibleEntries.map((entry) => <label className={`inventory-row ${entry.status}`} key={entry.selectionKey}>
            <input type="checkbox" checked={selectedKeys.has(entry.selectionKey)} disabled={entry.status !== "transferable"} aria-label={`${entry.item.displayName} ${statusLabel(entry.status)}`} onChange={() => toggleItem(entry.selectionKey)} />
            <span className={`inventory-kind ${entry.item.kind}`}>{categoryLabels[entry.item.kind]}</span>
            <span className="inventory-item-copy"><strong>{entry.item.displayName}</strong><small>{[providerLabels[entry.item.provider], entry.item.version ? `v${entry.item.version}` : undefined, sourceLabels[entry.item.source], entry.item.enabled ? "활성" : "비활성", entry.item.kind === "mcp" && entry.item.transport ? entry.item.transport.toUpperCase() : undefined].filter(Boolean).join(" · ")}</small><code>{entry.item.key}</code></span>
            <span className={`inventory-state ${entry.status}`}><strong>{statusLabel(entry.status)}</strong><small>{entry.reason}</small></span>
          </label>) : <div className="inventory-list-empty">선택한 종류에 표시할 항목이 없습니다.</div>}
        </fieldset>

        <div className="inventory-actions"><div><strong>{selectedEntries.length}개 선택</strong><small>자동 적용 가능한 플러그인만 선택할 수 있습니다.</small></div><button className="primary-button" type="button" disabled={!selectedEntries.length || busy} onClick={() => setReviewing(true)}>선택 항목 검토</button></div>

        {reviewing && <section className="inventory-review" aria-labelledby="inventory-review-title"><div><span className="eyebrow">IMPORT REVIEW</span><h3 id="inventory-review-title">현재 기기로 가져오기 전 확인</h3><p>{currentDeviceName}에 다음 플러그인을 설치합니다. 표시된 ID와 마켓플레이스를 확인하세요. 원본의 버전 표시는 참고 정보이며 설치 시 현재 기기 마켓플레이스가 제공하는 버전을 사용합니다.</p></div><ul>{selectedEntries.map((entry) => <li key={entry.selectionKey}><div><strong>{entry.item.displayName}</strong><code>{entry.item.key}</code></div><span>{providerLabels[entry.item.provider]}{entry.item.version ? ` · 원본 v${entry.item.version}` : ""}</span></li>)}</ul><div className="inventory-review-notice"><Icon name="lock" />비밀 값과 로컬 경로는 포함되지 않으며 다른 기기의 설정은 변경하지 않습니다.</div><div className="inventory-review-actions"><button className="secondary-button" type="button" disabled={busy} onClick={() => setReviewing(false)}>취소</button><button className="primary-button" type="button" disabled={busy} onClick={() => void applySelected()}>{action === "apply" ? "가져오는 중…" : `${selectedEntries.length}개 가져오기`}</button></div></section>}
      </>}

      {props.error && <p className="inventory-error" role="alert"><Icon name="warning" />{props.error}</p>}
      {localError && <p className="inventory-error" role="alert"><Icon name="warning" />{localError}</p>}
      <p className="inventory-result" aria-live="polite">{resultMessage}</p>
    </article>
  );
}
