# 동기화와 공급사 API 설정

## Supabase 설정

앱에는 공개 가능한 프로젝트 URL과 anon 키만 설정합니다.

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_ANON_KEY
```

두 값 중 하나라도 없으면 클라이언트는 동기화를 비활성화하고 로컬 기능만 유지합니다. `supabase/migrations/202607110001_initial_usage_sync.sql`은 검토용이며 자동 적용되지 않습니다. 적용 전 대상 Supabase 프로젝트와 신규 테이블, RLS 정책의 영향을 확인해야 합니다.

인증은 이메일 매직링크를 사용합니다. 링크가 돌아올 앱 URL을 Supabase Auth의 허용된 Redirect URL에 등록하고, 콜백에서 받은 세션을 `SupabaseAuthService.acceptSession`에 전달합니다.

## 공급사 관리자 자격 증명

공급사 키와 Google OAuth 액세스 토큰은 어댑터 호출 인자로만 전달합니다. Supabase 테이블과 사용 이벤트의 `metadata`에는 저장하지 않습니다. 데스크톱 앱에서는 Windows Credential Manager 같은 OS 비밀 저장소에 보관해야 합니다.

- OpenAI는 조직 Admin API 키로 `/v1/organization/usage/completions`를 조회합니다.
- Anthropic은 Admin API 키로 `/v1/organizations/usage_report/messages`를 조회합니다.
- Google Cloud는 사용자 OAuth 액세스 토큰으로 BigQuery `jobs.query`를 호출합니다. `billingTable`에는 Billing Export의 `project.dataset.gcp_billing_export_v1_ACCOUNT` 테이블을 지정합니다.

토큰 레코드와 비용 레코드는 각각 `kind: "tokens"`, `kind: "cost"`로 유지합니다. 비용을 토큰으로 환산하거나 개인 구독의 잔여 한도처럼 표시하면 안 됩니다.

## 데이터 최소화

동기화 데이터에는 토큰 수, 모델, 시간, 해시 기반 프로젝트 식별자와 사용자가 직접 정한 세션 제목만 포함합니다. 프롬프트, 응답, 코드, 전체 로컬 경로, 공급사 API 키는 업로드하지 않습니다.

Git 프로젝트는 정규화한 원격 주소를 로컬에서 해시한 값을 `git_remote_hash`에 저장합니다. 원격이 없는 폴더는 로컬 식별자를 해시해 `local_project_hash`에 저장합니다.

## 공식 API 근거

- OpenAI Usage API. https://platform.openai.com/docs/api-reference/usage
- Anthropic Admin API usage report. https://docs.anthropic.com/en/api/admin-api/usage-cost/get-messages-usage-report
- BigQuery `jobs.query`. https://cloud.google.com/bigquery/docs/reference/rest/v2/jobs/query
- Cloud Billing Export. https://cloud.google.com/billing/docs/how-to/export-data-bigquery
