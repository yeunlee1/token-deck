// 자동 인식한 프로젝트 이름을 확인하고 사용자 지정 이름으로 바꾸는 인라인 편집기
import type { FormEvent } from "react";
import { Icon } from "./Icon";

interface ProjectNameEditorProps {
  name: string;
  source: string;
  editing: boolean;
  draft: string;
  onStart: () => void;
  onDraftChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

export function ProjectNameEditor(props: ProjectNameEditorProps) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    props.onSave();
  };

  if (props.editing) {
    return <form className="project-name-form" onSubmit={submit}>
      <input autoFocus aria-label="프로젝트 이름" maxLength={80} value={props.draft} onChange={(event) => props.onDraftChange(event.target.value)} />
      <button className="project-name-save" aria-label="프로젝트 이름 저장">저장</button>
      <button type="button" className="project-name-cancel" aria-label="프로젝트 이름 편집 취소" onClick={props.onCancel}>취소</button>
    </form>;
  }

  return <div className="project-name-copy">
    <div className="project-name-line"><strong>{props.name}</strong><button className="project-name-edit" aria-label={`${props.name} 이름 수정`} onClick={props.onStart}><Icon name="edit" /></button></div>
    <small>{props.source}</small>
  </div>;
}
