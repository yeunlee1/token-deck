// 프로젝트 자동 이름과 사용자 지정 이름 저장 규칙을 검증하는 테스트
import { describe, expect, it } from "vitest";
import {
  PROJECT_NAMES_STORAGE_KEY,
  inferProjectDisplayName,
  readProjectNameOverrides,
  resolveProjectDisplayName,
  setProjectNameOverride,
  writeProjectNameOverrides,
} from "./project-display";

describe("project display names", () => {
  it("GitHub 원격에서는 저장소 이름만 추출한다", () => {
    expect(inferProjectDisplayName({ gitRemote: "git@github.com:OpenAI/token-deck.git", cwd: "C:\\Users\\secret\\fallback" })).toBe("token-deck");
  });

  it("원격이 없으면 cwd의 마지막 폴더명만 사용한다", () => {
    expect(inferProjectDisplayName({ cwd: "C:\\Users\\person\\private\\newSteel" })).toBe("newSteel");
    expect(JSON.stringify(inferProjectDisplayName({ cwd: "C:\\Users\\person\\private\\newSteel" }))).not.toContain("person");
  });

  it("사용자 이름을 우선하고 빈 이름은 재정의를 삭제한다", () => {
    const custom = setProjectNameOverride({}, "project-1", "  내 프로젝트  ");
    expect(resolveProjectDisplayName("project-1", { "project-1": "자동 이름" }, custom)).toBe("내 프로젝트");
    expect(setProjectNameOverride(custom, "project-1", "   ")).toEqual({});
  });

  it("저장소 입출력에서 잘못된 값과 제어 문자를 정리한다", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    writeProjectNameOverrides(storage, { "project-1": "안전한 이름" });
    expect(values.has(PROJECT_NAMES_STORAGE_KEY)).toBe(true);
    values.set(PROJECT_NAMES_STORAGE_KEY, JSON.stringify({ "project-1": "이름\u0000", invalid: 42 }));
    expect(readProjectNameOverrides(storage)).toEqual({ "project-1": "이름" });
  });
});
