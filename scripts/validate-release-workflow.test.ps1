# 자동 배포 워크플로가 검증된 판올림만 게시하고 안전하게 재시도하는지 검증한다
[CmdletBinding()]
param(
    [string]$WorkflowPath = (Join-Path $PSScriptRoot "..\.github\workflows\release.yml"),
    [AllowEmptyString()][string]$WorkflowText
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($PSBoundParameters.ContainsKey('WorkflowText')) {
    $workflow = $WorkflowText
} else {
    $workflow = Get-Content -Raw -LiteralPath $WorkflowPath
}

function Assert-Contains {
    param(
        [Parameter(Mandatory = $true)][string]$Pattern,
        [Parameter(Mandatory = $true)][string]$Message
    )

    if ($workflow -notmatch $Pattern) {
        throw $Message
    }
}

Assert-Contains -Pattern '(?m)^\s*releaseDraft:\s*true\s*$' -Message '설치 파일과 자동 업데이트 메타데이터를 검증하기 전까지 판올림은 초안이어야 합니다.'
Assert-Contains -Pattern 'id:\s*tauri_release' -Message 'Tauri 배포 단계의 출력 식별자가 필요합니다.'
Assert-Contains -Pattern 'tauri-apps/tauri-action@84b9d35b5fc46c1e45415bdb6144030364f7ebc5' -Message '검증한 동작과 같은 고정 tauri-action 커밋을 사용해야 합니다.'
Assert-Contains -Pattern 'RELEASE_ID:\s*\$\{\{\s*steps\.tauri_release\.outputs\.releaseId\s*\}\}' -Message 'Tauri action이 생성하거나 재사용한 판올림 식별자로 자산을 검증해야 합니다.'

if ($workflow -match '(?m)^\s*releaseId:\s*') {
    throw '기존 초안 ID를 action 입력으로 넘기면 고정된 tauri-action이 __VERSION__ 태그 치환을 건너뛰므로 사용할 수 없습니다.'
}
if ($workflow -match 'steps\.release_guard\.outputs\.release_id') {
    throw '기존 초안은 고정된 tauri-action이 확장된 태그명으로 직접 찾아 재사용해야 합니다.'
}

Assert-Contains -Pattern 'gh api --paginate --slurp.+/releases\?per_page=100' -Message '태그 없는 오래된 초안도 찾도록 전체 판올림 페이지를 조회해야 합니다.'
if ([regex]::Matches($workflow, '\$release\.target_commitish\s*-ne\s*\$env:GITHUB_SHA').Count -lt 2) {
    throw '기존 초안과 게시 직전 초안이 모두 현재 커밋을 가리키는지 확인해야 합니다.'
}
Assert-Contains -Pattern '현재 커밋의 기존 \$tag 초안을 이어서 완성' -Message '같은 커밋의 태그 없는 초안을 안전하게 재시도할 수 있어야 합니다.'

Assert-Contains -Pattern 'latest\.json 자산이 정확히 하나' -Message 'latest.json 자산을 게시 전에 검증해야 합니다.'
Assert-Contains -Pattern 'setup\\\.exe\$' -Message '윈도우 설치 파일 자산을 게시 전에 검증해야 합니다.'
Assert-Contains -Pattern '설치 파일과 짝이 맞는 서명 자산이 정확히 하나' -Message '검증된 설치 파일과 정확히 짝이 맞는 서명 자산이 필요합니다.'
Assert-Contains -Pattern '필수 판올림 자산 중 내용이 비어 있는 파일' -Message '필수 자산 세 개가 모두 비어 있지 않은지 확인해야 합니다.'
Assert-Contains -Pattern 'latest\.json 버전이 빌드된 앱 버전과 일치하지 않습니다' -Message 'latest.json 버전이 실제 빌드 버전과 일치해야 합니다.'
Assert-Contains -Pattern 'signature\.Trim\(\)' -Message 'latest.json 서명과 설치 파일 서명 자산을 비교해야 합니다.'
Assert-Contains -Pattern 'latest\.json 설치 주소가 현재 판올림 태그' -Message 'latest.json 주소가 현재 태그와 설치 파일을 가리켜야 합니다.'
Assert-Contains -Pattern "Host\.Equals\('github\.com'" -Message 'latest.json 주소가 GitHub 호스트를 가리키는지 확인해야 합니다.'
Assert-Contains -Pattern '\$expectedPath\s*=\s*"/\$env:GITHUB_REPOSITORY/releases/download/' -Message 'latest.json 주소가 현재 저장소의 정확한 다운로드 경로인지 확인해야 합니다.'

if ([regex]::Matches($workflow, 'gh api --method PATCH').Count -ne 1) {
    throw '검증된 판올림을 게시하는 단 하나의 마지막 API 호출이 필요합니다.'
}
Assert-Contains -Pattern '-F draft=false' -Message '자산 검증 뒤 초안 상태를 해제해야 합니다.'
Assert-Contains -Pattern '-f make_latest=true' -Message '게시한 판올림을 자동 업데이트의 최신 판올림으로 지정해야 합니다.'

Assert-Contains -Pattern 'tauri\.conf\.json' -Message 'Tauri 앱 버전을 확인해야 합니다.'
Assert-Contains -Pattern 'Cargo\.toml' -Message 'Cargo 앱 버전을 확인해야 합니다.'
Assert-Contains -Pattern 'package\.json=' -Message 'package.json과 실제 앱 버전의 일치를 확인해야 합니다.'
Assert-Contains -Pattern '\$packageVersion\s*-ne\s*\$tauriVersion\s*-or\s*\$packageVersion\s*-ne\s*\$cargoVersion' -Message 'package.json, Tauri 설정과 Cargo 앱 버전을 서로 비교해야 합니다.'

$publishCall = $workflow.IndexOf('gh api --method PATCH', [StringComparison]::Ordinal)
$validationMarkers = @(
    '필수 판올림 자산 중 내용이 비어 있는 파일이 있습니다.',
    'latest.json 버전이 빌드된 앱 버전과 일치하지 않습니다.',
    'latest.json 설치 주소가 현재 판올림 태그와 저장소의 검증된 설치 파일을 가리키지 않습니다.',
    'latest.json 서명과 설치 파일 서명 자산이 일치하지 않습니다.'
)
foreach ($marker in $validationMarkers) {
    $validationCall = $workflow.IndexOf($marker, [StringComparison]::Ordinal)
    if ($validationCall -lt 0 -or $publishCall -le $validationCall) {
        throw '판올림 게시 호출은 필수 자산, 버전, URL과 서명 검증이 모두 끝난 뒤에만 실행해야 합니다.'
    }
}
$lastApiCall = $workflow.LastIndexOf('gh api ', [StringComparison]::Ordinal)
if ($lastApiCall -ne $publishCall) {
    throw '판올림 게시 PATCH가 워크플로의 마지막 GitHub API 호출이어야 합니다.'
}

Write-Host '자동 배포 원자성, 초안 재시도와 버전 불변성 검증이 통과했습니다.'
