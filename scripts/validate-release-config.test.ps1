# 배포용 Supabase 공개 키 검증이 안전한 키만 허용하는지 샘플로 확인하는 자동 테스트
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$validator = Join-Path $PSScriptRoot 'validate-release-config.ps1'

function ConvertTo-Base64Url {
    param([Parameter(Mandatory = $true)][string]$Value)

    return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Value)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function New-TestJwt {
    param([Parameter(Mandatory = $true)][string]$Role)

    $header = ConvertTo-Base64Url -Value '{"alg":"HS256","typ":"JWT"}'
    $payload = ConvertTo-Base64Url -Value (ConvertTo-Json @{ role = $Role } -Compress)
    return "$header.$payload.sample-signature"
}

function Assert-ValidationCase {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Key,
        [Parameter(Mandatory = $true)][bool]$ShouldPass
    )

    $env:VITE_SUPABASE_URL = 'https://sample.supabase.co'
    $env:VITE_SUPABASE_PUBLISHABLE_KEY = $Key
    $errorRecord = $null
    try {
        & $validator *> $null
    }
    catch {
        $errorRecord = $_
    }

    if ($ShouldPass -and $null -ne $errorRecord) {
        throw "허용 사례 '$Name' 검증이 실패했습니다. $($errorRecord.Exception.Message)"
    }
    if (-not $ShouldPass -and $null -eq $errorRecord) {
        throw "차단 사례 '$Name' 검증이 통과했습니다."
    }
}

$previousUrl = $env:VITE_SUPABASE_URL
$previousKey = $env:VITE_SUPABASE_PUBLISHABLE_KEY
try {
    Assert-ValidationCase -Name 'publishable key' -Key 'sb_publishable_browser_safe_sample' -ShouldPass $true
    Assert-ValidationCase -Name 'legacy anon JWT' -Key (New-TestJwt -Role 'anon') -ShouldPass $true
    Assert-ValidationCase -Name 'secret key' -Key 'sb_secret_server_only_sample' -ShouldPass $false
    Assert-ValidationCase -Name 'service role JWT' -Key (New-TestJwt -Role 'service_role') -ShouldPass $false
    Assert-ValidationCase -Name 'damaged JWT' -Key 'eyJ.invalid.signature' -ShouldPass $false
    $anonPayload = ConvertTo-Base64Url -Value (ConvertTo-Json @{ role = 'anon' } -Compress)
    Assert-ValidationCase -Name 'damaged JWT header' -Key "not-json.$anonPayload.sample-signature" -ShouldPass $false
    Assert-ValidationCase -Name 'unknown text' -Key 'database-password-like-value' -ShouldPass $false
}
finally {
    $env:VITE_SUPABASE_URL = $previousUrl
    $env:VITE_SUPABASE_PUBLISHABLE_KEY = $previousKey
}

Write-Host '배포 공개 설정 검증 테스트 7건이 통과했습니다.'
