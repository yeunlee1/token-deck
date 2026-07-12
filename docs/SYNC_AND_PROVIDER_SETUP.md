# 동기화와 공급사 API 설정

## Supabase 설정

앱의 설정 화면에는 공개 가능한 프로젝트 URL과 publishable key만 입력합니다. 빌드 기본값은 다음 환경 변수로도 지정할 수 있습니다.

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_YOUR_KEY
```

레거시 프로젝트는 `VITE_SUPABASE_ANON_KEY`도 계속 사용할 수 있지만 새 배포는 publishable key를 사용합니다. `sb_secret_` key, `service_role` key, 데이터베이스 비밀번호와 Google Client Secret은 앱이나 저장소에 넣지 않습니다. URL과 공개 키 중 하나라도 없으면 클라이언트는 동기화를 비활성화하고 로컬 기능만 유지합니다. 설정 화면의 값은 이 PC에만 저장됩니다. `supabase/migrations/202607110001_initial_usage_sync.sql`은 검토용이며 자동 적용되지 않습니다. 적용 시 `devices`, `projects`, `sessions`, `usage_events`, `sync_checkpoints` 테이블과 각 테이블의 RLS 정책이 새로 생성됩니다.

Token Deck 계정 인증은 이메일 매직링크와 Google 로그인을 사용합니다. Supabase Auth의 Redirect URLs에 `token-deck://auth`를 등록하고 Google 공급자를 활성화합니다. Google Cloud OAuth의 승인된 리디렉션 URI에는 Supabase 대시보드가 안내하는 `https://YOUR_PROJECT.supabase.co/auth/v1/callback`을 등록합니다. Google Client ID와 Client Secret은 Supabase의 Google 공급자 설정에만 저장하며 데스크톱 앱에는 포함하지 않습니다.

Google 로그인은 데스크톱 앱에서 PKCE S256 요청을 만들고 운영체제 기본 브라우저를 엽니다. 앱은 `token-deck://auth?code=...` 딥링크를 받은 뒤 같은 기기에 임시 저장한 verifier와 코드를 교환합니다. `state`가 현재 앱에서 시작한 요청과 다르거나 verifier가 없으면 콜백을 거부합니다. 데스크톱 앱은 딥링크 콜백을 단일 실행 인스턴스로 전달하고, 로그인 갱신 토큰은 Windows Credential Manager에 저장합니다.

Token Deck 계정 로그인은 AI 공급사 사용량 연결과 별개입니다. Google로 Token Deck에 로그인해도 Gemini 비용 권한이나 OpenAI·Anthropic 관리자 권한은 생기지 않습니다. 아래 공급사 자격 증명은 사용자가 조직 API 사용량을 선택적으로 조회할 때만 별도로 연결합니다.

동기화는 로컬 이벤트를 안정적인 ID로 upsert하고 원격 이벤트를 페이지 단위로 내려받습니다. 같은 계정으로 로그인한 다른 기기에서는 동일한 프로젝트와 세션 사용량이 합산됩니다. 네트워크 오류가 발생하면 로컬 데이터는 유지되고 다음 수집 주기에 다시 시도합니다.

## 공급사 관리자 자격 증명

공급사 키와 Google OAuth 액세스 토큰은 설정 화면에서 입력하며 Windows Credential Manager에 보관합니다. Supabase 테이블과 사용 이벤트의 `metadata`에는 저장하지 않습니다.

- OpenAI는 조직 Admin API 키로 `/v1/organization/usage/completions`를 조회합니다.
- Anthropic은 Admin API 키로 `/v1/organizations/usage_report/messages`를 조회합니다.
- Google Cloud는 사용자 OAuth 액세스 토큰으로 BigQuery `jobs.query`를 호출합니다. `billingTable`에는 Billing Export의 `project.dataset.gcp_billing_export_v1_ACCOUNT` 테이블을 지정합니다.

공급사 관리자 키는 각 조직의 관리 API 권한이 있어야 합니다. 토큰 사용량과 비용은 로컬 로그 및 조직 API에서 집계합니다. 개인 정액제의 잔여 한도는 이 사용량과 별개의 값으로 취급하며, Codex는 로컬 세션의 실제 5시간·주간 한도 이벤트를 읽고 Claude는 Claude Code status line 입력에 포함된 5시간·주간 한도를 사용합니다.

토큰 레코드와 비용 레코드는 각각 `kind: "tokens"`, `kind: "cost"`로 유지합니다. 비용이나 최근 토큰 사용량을 개인 구독의 잔여 한도로 환산하면 안 됩니다. Gemini CLI는 5시간·주간 구간이 아니라 일일 요청 쿼터를 사용하므로 해당 두 구간은 미제공으로 표시합니다.

## 데이터 최소화

동기화 데이터에는 토큰 수, 모델, 시간, 해시 기반 프로젝트 식별자와 사용자가 직접 정한 세션 제목만 포함합니다. 프롬프트, 응답, 코드, 전체 로컬 경로, 공급사 API 키는 업로드하지 않습니다.

Git 프로젝트는 정규화한 원격 주소를 로컬에서 해시한 값을 `git_remote_hash`에 저장합니다. 원격이 없는 폴더는 로컬 식별자를 해시해 `local_project_hash`에 저장합니다.

## 공식 API 근거

- Supabase PKCE flow. https://supabase.com/docs/guides/auth/sessions/pkce-flow
- Supabase Google login. https://supabase.com/docs/guides/auth/social-login/auth-google
- Tauri opener. https://v2.tauri.app/plugin/opener/
- OpenAI Usage API. https://platform.openai.com/docs/api-reference/usage
- Anthropic Admin API usage report. https://docs.anthropic.com/en/api/admin-api/usage-cost/get-messages-usage-report
- BigQuery `jobs.query`. https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/query
- Cloud Billing Export. https://cloud.google.com/billing/docs/how-to/export-data-bigquery
