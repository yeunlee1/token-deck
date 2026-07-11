# Gemini CLI 연동

Token Deck은 Gemini CLI 자체를 설치하거나 로그인 정보를 변경하지 않는다. 앱의 연동 화면에서 사용자가 명시적으로 설정 버튼을 누른 경우에만 사용자 설정 파일인 `%USERPROFILE%\.gemini\settings.json`을 변경한다.

설정 명령은 기존 JSON의 다른 항목을 보존하고 `telemetry` 아래의 다음 항목만 병합한다.

```json
{
  "telemetry": {
    "enabled": true,
    "target": "local",
    "outfile": "C:\\Users\\사용자\\.gemini\\telemetry.log",
    "logPrompts": false
  }
}
```

기존 설정 파일이 있으면 같은 폴더에 `settings.json.backup-<timestamp>` 백업을 먼저 만든다. 기존 파일이 올바른 JSON 객체가 아니면 백업이나 변경 없이 오류를 반환한다. 프롬프트 본문은 `logPrompts: false`로 로깅하지 않으며 Token Deck은 로컬 텔레메트리 파일에서 토큰 사용 이벤트만 읽는다.

앱에서 제공하는 네이티브 명령은 다음과 같다.

- `gemini_status`는 PATH에서 Gemini CLI 설치 여부와 버전을 확인하고 설정 상태를 읽기 전용으로 반환한다.
- `configure_gemini_telemetry`는 위 설정을 백업 후 병합한다.
- `autostart_status`는 Windows 사용자 자동 시작 상태를 읽는다.
- `set_autostart`는 현재 사용자 레지스트리의 자동 시작 항목을 켜거나 끈다.

Gemini CLI의 환경 변수나 프로젝트별 `.gemini/settings.json`은 사용자 설정을 덮어쓸 수 있다. 해당 재정의가 존재하면 Token Deck의 상태 화면에서 사용자 설정이 완료되어 보여도 실제 CLI 동작은 달라질 수 있다.
