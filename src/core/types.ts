// 공급사별 토큰 사용 기록을 공통 형식으로 정의하는 타입
export type Provider = "codex" | "claude" | "gemini";

export interface TokenBreakdown {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  tool: number;
}

export interface UsageEvent {
  id: string;
  provider: Provider;
  source: "local-jsonl" | "otel" | "provider-api";
  deviceId: string;
  sessionId: string;
  projectId: string;
  model?: string;
  occurredAt: string;
  tokens: TokenBreakdown;
  requestId?: string;
}

export interface CollectorContext {
  deviceId: string;
  projectId: string;
  sessionId?: string;
  now?: () => Date;
}

export interface CollectorState {
  codexCumulative: Record<string, TokenBreakdown>;
  codexRetiredSessionFilter: string;
  claudeRequestIds: Set<string>;
  geminiEventIds: Set<string>;
}

export function createCollectorState(): CollectorState {
  return {
    codexCumulative: {},
    codexRetiredSessionFilter: "",
    claudeRequestIds: new Set(),
    geminiEventIds: new Set(),
  };
}

export function tokenTotal(tokens: TokenBreakdown): number {
  return tokens.input + tokens.cached + tokens.output + tokens.reasoning + tokens.tool;
}
