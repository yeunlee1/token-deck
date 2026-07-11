// 원격 저장소와 로컬 경로의 프로젝트 식별 규칙을 검증하는 테스트
import { describe, expect, it } from "vitest";

import { identifyProject, normalizeGitRemote } from "./project-identity";

describe("project identity", () => {
  it("normalizes SSH and HTTPS remotes to the same cross-device identity", () => {
    expect(normalizeGitRemote("git@GitHub.com:OpenAI/Example.git")).toBe("github.com/openai/example");
    const first = identifyProject({ gitRemote: "git@github.com:OpenAI/Example.git", localPath: "C:\\work\\one" });
    const second = identifyProject({ gitRemote: "https://github.com/openai/example", localPath: "D:\\other\\two" });
    expect(first.id).toBe(second.id);
    expect(first.kind).toBe("git-remote");
  });

  it("does not expose the full local path in a local project id", () => {
    const project = identifyProject({ localPath: "C:\\Users\\person\\secret-project" });
    expect(project.id).toMatch(/^local_[a-f0-9]{64}$/);
    expect(JSON.stringify(project)).not.toContain("secret-project");
  });
});
