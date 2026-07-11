// JSONL과 텔레메트리 메타데이터를 안전하게 정규화하는 공통 도우미
import type { TokenBreakdown } from "./types";

export type JsonObject = Record<string, unknown>;

export const EMPTY_TOKENS: TokenBreakdown = {
  input: 0,
  cached: 0,
  output: 0,
  reasoning: 0,
  tool: 0,
};

export function parseJsonLines(input: string): JsonObject[] {
  const records: JsonObject[] = [];
  for (const line of input.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isObject(value)) records.push(value);
    } catch {
      // A writer can leave a partial final line while the collector is reading.
    }
  }
  return records;
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function objectAt(value: unknown, ...path: string[]): JsonObject | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return isObject(current) ? current : undefined;
}

export function valueAt(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

export function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

export function finiteNumber(...values: unknown[]): number {
  for (const value of values) {
    const number = typeof value === "string" && value.trim() ? Number(value) : value;
    if (typeof number === "number" && Number.isFinite(number) && number >= 0) {
      return Math.floor(number);
    }
  }
  return 0;
}

export function stableId(...metadata: Array<string | number | undefined>): string {
  const bytes = new TextEncoder().encode(metadata.map((value) => value ?? "").join("\u001f"));
  return [0n, 1n, 2n, 3n].map((salt) => {
    let hashValue = 0xcbf29ce484222325n ^ salt;
    for (const character of bytes) {
      hashValue ^= BigInt(character);
      hashValue = BigInt.asUintN(64, hashValue * 0x100000001b3n);
    }
    return hashValue.toString(16).padStart(16, "0");
  }).join("");
}

export function isoTimestamp(value: unknown, fallback: Date): string {
  const date = typeof value === "string" || typeof value === "number" ? new Date(value) : fallback;
  return Number.isNaN(date.getTime()) ? fallback.toISOString() : date.toISOString();
}

export function attributesToObject(value: unknown): JsonObject {
  if (isObject(value)) return value;
  if (!Array.isArray(value)) return {};

  return Object.fromEntries(
    value.flatMap((item) => {
      if (!isObject(item) || typeof item.key !== "string") return [];
      const wrapped = isObject(item.value) ? Object.values(item.value)[0] : item.value;
      return [[item.key, wrapped]];
    }),
  );
}
