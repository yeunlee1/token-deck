// 계정 이벤트를 기기와 프로젝트 양방향으로 일관되게 집계하는 순수 모듈
import { tokenTotal, type Provider, type TokenBreakdown, type UsageEvent } from "./types";

const PROVIDERS: Provider[] = ["codex", "claude", "gemini"];

export interface AccountUsageMeasure {
  tokens: TokenBreakdown;
  totalTokens: number;
  requestCount: number;
}

export interface AccountUsageTotals extends AccountUsageMeasure {
  providerCount: number;
  byProvider: Record<Provider, AccountUsageMeasure>;
}

export interface AccountUsageCell extends AccountUsageTotals {
  deviceId: string;
  projectId: string;
}

export interface DeviceUsageAggregate {
  deviceId: string;
  totals: AccountUsageTotals;
  projects: AccountUsageCell[];
}

export interface ProjectUsageAggregate {
  projectId: string;
  totals: AccountUsageTotals;
  devices: AccountUsageCell[];
}

export interface AccountUsageMatrix {
  totals: AccountUsageTotals;
  cells: AccountUsageCell[];
  devices: DeviceUsageAggregate[];
  projects: ProjectUsageAggregate[];
}

interface MutableUsageTotals {
  tokens: TokenBreakdown;
  requestCount: number;
  byProvider: Record<Provider, AccountUsageMeasure>;
}

/**
 * 중복 제거가 끝난 정규화 이벤트 하나를 요청 하나로 간주합니다.
 * 반환된 기기 보기와 프로젝트 보기는 같은 셀 객체를 공유하므로 양방향 합계의 기준이 같습니다.
 */
export function buildAccountUsageMatrix(events: UsageEvent[]): AccountUsageMatrix {
  const cellsByDevice = new Map<string, Map<string, MutableUsageTotals>>();

  for (const event of uniqueEvents(events)) {
    let projects = cellsByDevice.get(event.deviceId);
    if (!projects) {
      projects = new Map();
      cellsByDevice.set(event.deviceId, projects);
    }
    let totals = projects.get(event.projectId);
    if (!totals) {
      totals = emptyMutableTotals();
      projects.set(event.projectId, totals);
    }
    addEvent(totals, event);
  }

  const cells = [...cellsByDevice.entries()].flatMap(([deviceId, projects]) => (
    [...projects.entries()].map(([projectId, totals]) => ({
      deviceId,
      projectId,
      ...finishTotals(totals),
    }))
  ));

  const devices = [...groupCells(cells, (cell) => cell.deviceId)].map(([deviceId, projects]) => ({
    deviceId,
    totals: sumCells(projects),
    projects: sortCells(projects, (cell) => cell.projectId),
  })).sort(compareAggregates);

  const projects = [...groupCells(cells, (cell) => cell.projectId)].map(([projectId, devicesForProject]) => ({
    projectId,
    totals: sumCells(devicesForProject),
    devices: sortCells(devicesForProject, (cell) => cell.deviceId),
  })).sort(compareAggregates);

  return {
    totals: sumCells(cells),
    cells,
    devices,
    projects,
  };
}

function uniqueEvents(events: UsageEvent[]): UsageEvent[] {
  return [...new Map(events.map((event) => [event.id, event])).values()];
}

function emptyTokens(): TokenBreakdown {
  return { input: 0, cached: 0, output: 0, reasoning: 0, tool: 0 };
}

function emptyMeasure(): AccountUsageMeasure {
  return { tokens: emptyTokens(), totalTokens: 0, requestCount: 0 };
}

function emptyProviderMeasures(): Record<Provider, AccountUsageMeasure> {
  return {
    codex: emptyMeasure(),
    claude: emptyMeasure(),
    gemini: emptyMeasure(),
  };
}

function emptyMutableTotals(): MutableUsageTotals {
  return { tokens: emptyTokens(), requestCount: 0, byProvider: emptyProviderMeasures() };
}

function addEvent(totals: MutableUsageTotals, event: UsageEvent): void {
  addTokens(totals.tokens, event.tokens);
  totals.requestCount += 1;
  const provider = totals.byProvider[event.provider];
  addTokens(provider.tokens, event.tokens);
  provider.totalTokens += tokenTotal(event.tokens);
  provider.requestCount += 1;
}

function addTokens(target: TokenBreakdown, source: TokenBreakdown): void {
  target.input += source.input;
  target.cached += source.cached;
  target.output += source.output;
  target.reasoning += source.reasoning;
  target.tool += source.tool;
}

function finishTotals(totals: MutableUsageTotals): AccountUsageTotals {
  return {
    tokens: { ...totals.tokens },
    totalTokens: tokenTotal(totals.tokens),
    requestCount: totals.requestCount,
    providerCount: PROVIDERS.filter((provider) => totals.byProvider[provider].requestCount > 0).length,
    byProvider: Object.fromEntries(PROVIDERS.map((provider) => [provider, {
      tokens: { ...totals.byProvider[provider].tokens },
      totalTokens: totals.byProvider[provider].totalTokens,
      requestCount: totals.byProvider[provider].requestCount,
    }])) as Record<Provider, AccountUsageMeasure>,
  };
}

function groupCells(cells: AccountUsageCell[], keyOf: (cell: AccountUsageCell) => string): Map<string, AccountUsageCell[]> {
  const groups = new Map<string, AccountUsageCell[]>();
  for (const cell of cells) {
    const key = keyOf(cell);
    groups.set(key, [...(groups.get(key) ?? []), cell]);
  }
  return groups;
}

function sumCells(cells: AccountUsageCell[]): AccountUsageTotals {
  const totals = emptyMutableTotals();
  for (const cell of cells) {
    addTokens(totals.tokens, cell.tokens);
    totals.requestCount += cell.requestCount;
    for (const provider of PROVIDERS) {
      const source = cell.byProvider[provider];
      const target = totals.byProvider[provider];
      addTokens(target.tokens, source.tokens);
      target.totalTokens += source.totalTokens;
      target.requestCount += source.requestCount;
    }
  }
  return finishTotals(totals);
}

function sortCells(cells: AccountUsageCell[], idOf: (cell: AccountUsageCell) => string): AccountUsageCell[] {
  return [...cells].sort((left, right) => right.totalTokens - left.totalTokens || idOf(left).localeCompare(idOf(right)));
}

function compareAggregates(
  left: DeviceUsageAggregate | ProjectUsageAggregate,
  right: DeviceUsageAggregate | ProjectUsageAggregate,
): number {
  const leftId = "deviceId" in left ? left.deviceId : left.projectId;
  const rightId = "deviceId" in right ? right.deviceId : right.projectId;
  return right.totals.totalTokens - left.totals.totalTokens || leftId.localeCompare(rightId);
}
