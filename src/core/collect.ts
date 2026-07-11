// Tauri가 읽은 공급사 로그 문서를 프로젝트별 사용 이벤트로 연결하는 오케스트레이터
import { parseClaudeJsonl } from "./claude";
import { parseCodexJsonl } from "./codex";
import { parseGeminiOtel } from "./gemini";
import { firstString, isObject, parseJsonLines, valueAt } from "./parse-utils";
import { identifyProject } from "./project-identity";
import { inferProjectDisplayName, type ProjectNameMap } from "./project-display";
import type { CollectorState, Provider, UsageEvent } from "./types";

export interface CollectorDocument {
  provider: Provider;
  path: string;
  content: string;
  gitRemote?: string;
}

interface DocumentMetadata {
  cwd?: string;
  sessionId?: string;
}

function metadataFromDocument(document: CollectorDocument): DocumentMetadata {
  for (const record of parseJsonLines(document.content)) {
    const cwd = firstString(
      record.cwd,
      valueAt(record, "payload", "cwd"),
      valueAt(record, "workspace", "path"),
      valueAt(record, "attributes", "project_dir"),
    );
    const sessionId = firstString(
      record.sessionId,
      record.session_id,
      valueAt(record, "payload", "session_id"),
      valueAt(record, "payload", "id"),
    );
    if (cwd || sessionId) return { cwd, sessionId };
  }

  try {
    const root: unknown = JSON.parse(document.content);
    if (isObject(root)) {
      return {
        cwd: firstString(root.cwd, valueAt(root, "resource", "attributes", "project_dir")),
        sessionId: firstString(root.sessionId, root.session_id),
      };
    }
  } catch {
    // Invalid or partial documents are handled by the provider parser.
  }
  return {};
}

export function collectUsageDocuments(
  documents: CollectorDocument[],
  deviceId: string,
  state: CollectorState,
): UsageEvent[] {
  return documents.flatMap((document) => {
    const metadata = metadataFromDocument(document);
    const projectId = identifyProject({
      gitRemote: document.gitRemote,
      localPath: metadata.cwd ?? `log:${document.path}`,
    }).id;
    const context = { deviceId, projectId, sessionId: metadata.sessionId };

    switch (document.provider) {
      case "codex":
        return parseCodexJsonl(document.content, context, state);
      case "claude":
        return parseClaudeJsonl(document.content, context, state);
      case "gemini":
        return parseGeminiOtel(document.content, context, state);
    }
  });
}

export function collectProjectDisplayNames(documents: CollectorDocument[]): ProjectNameMap {
  const names: ProjectNameMap = {};
  for (const document of documents) {
    const metadata = metadataFromDocument(document);
    const name = inferProjectDisplayName({ gitRemote: document.gitRemote, cwd: metadata.cwd });
    if (!name) continue;
    const projectId = identifyProject({
      gitRemote: document.gitRemote,
      localPath: metadata.cwd ?? `log:${document.path}`,
    }).id;
    names[projectId] = name;
  }
  return names;
}
