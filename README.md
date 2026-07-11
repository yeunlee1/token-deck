# Token Deck

Codex, Claude Code, Gemini CLI와 각 공급사의 API 사용량을 한 화면에서 비교하는 Windows 우선 데스크톱 앱입니다.

## 현재 구현

- Codex와 Claude Code JSONL 수집 및 중복 없는 토큰 집계.
- Gemini CLI OpenTelemetry 토큰 이벤트 수집.
- Git 원격 기반 프로젝트 통합 식별.
- Tauri 트레이 앱과 React 사용량 대시보드.
- Supabase 매직 링크 인증, RLS 스키마, 멱등 동기화 계층.
- OpenAI Usage, Anthropic Admin, Google Cloud Billing 커넥터 골격.
- 프롬프트, 코드, 전체 로컬 경로를 업로드하지 않는 메타데이터 전용 설계.

## 실행

```powershell
npm install
npm run dev
```

Tauri 데스크톱 모드는 Rust와 Microsoft C++ 빌드 도구가 필요합니다.

```powershell
npm run desktop:dev
```

## 환경 변수

`.env.example`을 `.env.local`로 복사한 뒤 Supabase 프로젝트 정보를 입력합니다. 값이 없으면 클라우드 기능만 비활성화되고 로컬 대시보드는 계속 동작합니다.

## 검증

```powershell
npm test
npm run build
npm run desktop:build
```

`supabase/migrations`의 SQL은 자동 적용되지 않습니다. 대상 데이터베이스와 영향 범위를 확인한 뒤 별도로 승인받아 적용해야 합니다.
