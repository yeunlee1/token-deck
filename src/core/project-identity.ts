// 여러 기기의 동일 저장소를 개인 경로 노출 없이 식별하는 도우미
export interface ProjectIdentity {
  id: string;
  kind: "git-remote" | "local-path";
  normalizedRemote?: string;
}

export function normalizeGitRemote(remote: string): string {
  const trimmed = remote.trim();
  const scpLike = trimmed.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  const urlValue = scpLike && !trimmed.includes("://")
    ? `https://${scpLike[1]}/${scpLike[2]}`
    : trimmed;

  try {
    const url = new URL(urlValue);
    const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return `${url.hostname.toLowerCase()}/${path.toLowerCase()}`;
  } catch {
    return trimmed.replace(/\\/g, "/").replace(/\.git$/i, "").replace(/\/+$/g, "").toLowerCase();
  }
}

function hash(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return [0n, 1n, 2n, 3n].map((salt) => {
    let hashValue = 0xcbf29ce484222325n ^ salt;
    for (const character of bytes) {
      hashValue ^= BigInt(character);
      hashValue = BigInt.asUintN(64, hashValue * 0x100000001b3n);
    }
    return hashValue.toString(16).padStart(16, "0");
  }).join("");
}

export function identifyProject(input: { gitRemote?: string; localPath: string }): ProjectIdentity {
  if (input.gitRemote?.trim()) {
    const normalizedRemote = normalizeGitRemote(input.gitRemote);
    return { id: `git_${hash(normalizedRemote)}`, kind: "git-remote", normalizedRemote };
  }
  const normalizedPath = input.localPath.replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
  return { id: `local_${hash(normalizedPath)}`, kind: "local-path" };
}
