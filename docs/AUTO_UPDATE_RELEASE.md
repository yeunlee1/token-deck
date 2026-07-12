<!-- Token Deck 자동 업데이트의 키 관리와 GitHub 배포 절차를 설명하는 문서 -->
# 자동 업데이트 배포 안내

Token Deck은 Tauri 2 updater와 GitHub Releases를 사용합니다. 설치된 앱은 시작할 때 아래 주소의 `latest.json`을 확인합니다.

```text
https://github.com/yeunlee1/token-deck/releases/latest/download/latest.json
```

새 버전이 있으면 사용자에게 설치 여부를 묻습니다. 사용자가 동의하면 서명을 검증한 설치 파일을 내려받아 수동 조작 없이 설치하고 앱을 재실행합니다.

## 최초 한 번 필요한 GitHub 설정

저장소의 `Settings > Environments`에서 `판올림-서명` 환경을 만들고 배포 브랜치를 `main`으로 제한한 뒤 본인을 필수 검토자로 지정합니다. 다음 Actions secret은 저장소 전체가 아니라 이 환경에만 추가합니다.

- `TAURI_SIGNING_PRIVATE_KEY`에는 Tauri signer가 만든 비공개키 파일의 전체 내용을 넣습니다.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`에는 키 생성 때 지정한 암호를 넣습니다. 암호 없는 키라면 빈 값으로 두거나 만들지 않아도 됩니다.

운영 계정 로그인을 설치 파일에 기본 활성화하려면 `Settings > Secrets and variables > Actions`의 Actions variables에 아래 공개 값도 추가합니다.

- `VITE_SUPABASE_URL`에는 운영 Supabase 프로젝트 URL을 넣습니다.
- `VITE_SUPABASE_PUBLISHABLE_KEY`에는 운영 프로젝트의 publishable key를 넣습니다.

Google Client Secret, Supabase secret key, service role key, 데이터베이스 비밀번호는 설치 파일이나 Actions variables에 넣지 않습니다.

비공개키와 암호는 저장소, 설치 파일, 로그, 문서에 커밋하지 않습니다. 비공개키를 잃어버리면 이미 설치된 앱에 같은 업데이트 채널로 새 버전을 전달할 수 없으므로 별도 보안 저장소에 백업합니다.

판올림 워크플로는 `main`에서만 실행되고 `판올림-서명` 환경 승인을 통과한 뒤 서명키를 받습니다. 사용하는 외부 GitHub Actions도 변경 가능한 태그가 아니라 검증한 커밋 해시로 고정합니다.

공개키만 `src-tauri/tauri.conf.json`의 `plugins.updater.pubkey`에 들어갑니다. 공개키는 업데이트 파일의 서명을 검증하는 용도이므로 앱에 포함되어도 됩니다.

## 새 버전 배포 순서

1. `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`의 버전을 동일하게 올립니다.
2. 테스트와 데스크톱 빌드를 통과시킨 뒤 기본 브랜치에 푸시합니다.
3. GitHub 저장소의 `Actions > 윈도우 설치 파일 배포 > Run workflow`를 실행합니다.
4. 작업이 끝나면 GitHub Releases에 생성된 판올림 초안의 설치 파일, 서명 파일, `latest.json`을 확인합니다.
5. 판올림 초안을 게시합니다. 게시된 시점부터 기존 설치본이 새 버전을 감지합니다.

워크플로는 실수로 검증 전 업데이트가 배포되지 않도록 초안만 만듭니다. GitHub의 `latest` 주소는 초안 판올림을 제공하지 않으므로 게시 전에는 사용자에게 노출되지 않습니다.

`0.3.0`은 자동 업데이트 코드와 공개키가 처음 포함된 기준 버전이므로 사용자가 설치 파일로 한 번 설치해야 합니다. 그 뒤 `0.3.1`처럼 더 높은 버전의 판올림을 게시하면 설치된 앱이 이를 감지합니다.

## 생성되는 핵심 파일

- `Token Deck_x.x.x_x64-setup.exe`는 신규 설치와 수동 업데이트용 NSIS 설치 파일입니다.
- NSIS updater 산출물은 앱 내부 자동 설치에 사용됩니다.
- `.sig` 파일은 updater가 설치 파일의 위변조 여부를 검증할 때 사용합니다.
- `latest.json`은 버전, 다운로드 주소, 플랫폼, 서명을 담는 업데이트 색인입니다.

## 서명의 구분

Tauri updater 서명은 업데이트 파일의 위변조를 막습니다. Windows Authenticode 코드 서명은 SmartScreen 경고를 줄이고 배포자를 표시하는 별도 서명입니다. 여러 사람에게 정식 배포하기 전에는 Windows 코드 서명 인증서도 추가하는 것을 권장합니다.

## 관련 공식 문서

- [Tauri updater 플러그인](https://v2.tauri.app/plugin/updater/)
- [Tauri GitHub Actions 배포](https://v2.tauri.app/distribute/pipelines/github/)
- [Tauri Windows 코드 서명](https://v2.tauri.app/distribute/sign/windows/)
