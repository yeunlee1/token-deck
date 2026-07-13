# Token Deck

Codex, Claude Code, Gemini CLI와 각 공급사의 API 사용량을 한 화면에서 비교하는 Windows 우선 데스크톱 앱입니다.

## 구현된 기능

- Codex와 Claude Code JSONL 수집 및 중복 없는 토큰 집계.
- Gemini CLI OpenTelemetry 토큰 이벤트 수집.
- Git 원격 기반 프로젝트 통합 식별.
- Tauri 트레이 앱과 React 사용량 대시보드.
- 최초 실행 Google·이메일·로컬 전용 선택과 Supabase 계정별 기기·프로젝트·세션·사용량 멱등 동기화.
- 같은 계정의 모든 기기 토큰 총합과 기기별·프로젝트별 교차 사용량 분석.
- 실제 PC 이름 기반 기기 등록 목록과 앱 버전·최근 연결·최근 토큰 시각 표시.
- 계정 기기별 스킬·MCP·플러그인 메타데이터 비교와 검토 후 안전한 플러그인 가져오기.
- 공급사를 고르는 미니모드, 5시간·주간 잔여 한도, 선택 기간 총 토큰 표시와 표시 설정.
- 다크·봄·여름·가을·겨울·모던 블루 여섯 가지 화면 테마와 기기별 선택 저장.
- 앱 시작 시 새 버전을 확인하고 사용자 동의 후 설치하는 서명 기반 자동 업데이트.
- OpenAI Usage, Anthropic Admin, Google Cloud Billing 실데이터 커넥터.
- 운영 Supabase 연결 상태, 로그인 화면 복귀, 공급사 자격 증명과 세션 제목 관리.
- Windows Credential Manager를 통한 공급사 키와 로그인 갱신 토큰 보관.
- Gemini CLI 설치 상태 확인과 프롬프트를 제외한 로컬 텔레메트리 설정.
- Windows 로그인 시 트레이 백그라운드 자동 시작.
- 프롬프트, 코드, 스킬 본문, MCP 명령·비밀값과 전체 로컬 경로를 업로드하지 않는 메타데이터 전용 설계.

## 실행

```powershell
npm install
npm run dev
```

Tauri 데스크톱 모드는 Rust와 Microsoft C++ 빌드 도구가 필요합니다.

```powershell
npm run desktop:dev
```

## 클라우드 연결

공식 설치 파일은 빌드할 때 운영 Supabase 프로젝트 URL과 publishable key를 포함하며 일반 사용자는 서버 정보를 입력하지 않습니다. 로컬 개발에서는 `.env.example`을 `.env.local`로 복사해 빌드 기본값을 지정합니다. 개발 모드에서만 서버 덮어쓰기를 허용하고 운영 모드는 빌드 기본값으로 고정됩니다. 값이 없으면 클라우드 기능만 비활성화되고 로컬 대시보드는 계속 동작합니다. `secret`, `service_role` key와 Google Client Secret은 설치 파일에 포함하지 않습니다.

원격 DB에는 `supabase/migrations/202607110001_initial_usage_sync.sql`과 `supabase/migrations/202607120001_device_setting_snapshots.sql`을 순서대로 한 번 적용해야 합니다. SQL은 계정 격리 테이블과 RLS 정책을 만들며 자동 적용되지 않습니다.

자세한 절차는 `docs/SYNC_AND_PROVIDER_SETUP.md`, `docs/DEVICE_SETTINGS_SYNC.md`, `docs/GEMINI_SETUP.md`, `docs/AUTO_UPDATE_RELEASE.md`를 확인합니다.

## 검증

```powershell
npm test
npm run build
npm run desktop:build
```

Windows 설치 파일은 `src-tauri/target/release/bundle/nsis/Token Deck_0.5.1_x64-setup.exe`에 생성됩니다.

자동 업데이트가 처음 포함된 `0.3.0`은 사용자가 설치 파일로 한 번 설치해야 합니다. 이후 게시되는 더 높은 버전부터 앱 안에서 업데이트할 수 있습니다.
