// 프로젝트 식별자에 안전한 자동 이름과 사용자 지정 이름을 연결하는 도우미
import { normalizeGitRemote } from "./project-identity";

export type ProjectNameMap = Record<string, string>;

export interface ProjectNameStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const PROJECT_NAMES_STORAGE_KEY = "token-deck-project-names";

export function inferProjectDisplayName(input: { gitRemote?: string; cwd?: string }): string | undefined {
  if (input.gitRemote?.trim()) {
    const remote = normalizeGitRemote(input.gitRemote);
    const repoName = remote.split("/").filter(Boolean).at(-1);
    const safe = sanitizeProjectName(repoName);
    if (safe) return safe;
  }
  if (input.cwd?.trim()) {
    const segments = input.cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean);
    return sanitizeProjectName(segments.at(-1));
  }
  return undefined;
}

export function sanitizeProjectName(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
  return normalized && normalized !== "." && normalized !== ".." ? normalized : undefined;
}

export function setProjectNameOverride(current: ProjectNameMap, projectId: string, name: string): ProjectNameMap {
  const next = { ...current };
  const safe = sanitizeProjectName(name);
  if (safe) next[projectId] = safe;
  else delete next[projectId];
  return next;
}

export function resolveProjectDisplayName(projectId: string, inferred: ProjectNameMap, overrides: ProjectNameMap): string {
  return overrides[projectId] ?? inferred[projectId] ?? `프로젝트 ${projectId.slice(-6).toUpperCase()}`;
}

export function readProjectNameOverrides(storage: ProjectNameStorage): ProjectNameMap {
  try {
    const value: unknown = JSON.parse(storage.getItem(PROJECT_NAMES_STORAGE_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).flatMap(([id, name]) => {
      const safe = typeof name === "string" ? sanitizeProjectName(name) : undefined;
      return id && safe ? [[id, safe]] : [];
    }));
  } catch {
    return {};
  }
}

export function writeProjectNameOverrides(storage: ProjectNameStorage, names: ProjectNameMap): void {
  storage.setItem(PROJECT_NAMES_STORAGE_KEY, JSON.stringify(names));
}
