# 운영 설치 파일에 포함할 Supabase 공개 설정이 안전한 형식인지 검증하는 스크립트
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function ConvertFrom-Base64UrlJson {
    param([Parameter(Mandatory = $true)][string]$Value)

    if ($Value -notmatch '^[A-Za-z0-9_-]+$') {
        return $null
    }

    $base64 = $Value.Replace('-', '+').Replace('_', '/')
    switch ($base64.Length % 4) {
        0 { }
        2 { $base64 += '==' }
        3 { $base64 += '=' }
        default { return $null }
    }

    try {
        $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($base64))
        return $json | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Test-SupabasePublishableKey {
    param([Parameter(Mandatory = $true)][string]$Value)

    $key = $Value.Trim()
    if ($key -match '^sb_publishable_[A-Za-z0-9_-]+$') {
        return $true
    }

    $parts = $key.Split('.')
    $invalidPart = $parts | Where-Object {
        [string]::IsNullOrWhiteSpace($_) -or $_ -notmatch '^[A-Za-z0-9_-]+$' -or ([string]$_).Length % 4 -eq 1
    }
    if ($parts.Count -ne 3 -or $null -ne $invalidPart) {
        return $false
    }

    $header = ConvertFrom-Base64UrlJson -Value $parts[0]
    $payload = ConvertFrom-Base64UrlJson -Value $parts[1]
    return $null -ne $header -and $null -ne $payload -and $payload.PSObject.Properties.Name -contains 'role' -and [string]$payload.role -ceq 'anon'
}

$url = $env:VITE_SUPABASE_URL
$key = $env:VITE_SUPABASE_PUBLISHABLE_KEY
$missing = @()
if ([string]::IsNullOrWhiteSpace($url)) {
    $missing += 'VITE_SUPABASE_URL'
}
if ([string]::IsNullOrWhiteSpace($key)) {
    $missing += 'VITE_SUPABASE_PUBLISHABLE_KEY'
}
if ($missing.Count -gt 0) {
    throw "운영 설치 파일을 만들 수 없습니다. Actions variables에 다음 값을 먼저 등록하세요. $($missing -join ', ')"
}

$parsedUrl = $null
if (-not [Uri]::TryCreate($url.Trim(), [UriKind]::Absolute, [ref]$parsedUrl) -or $parsedUrl.Scheme -ne 'https') {
    throw 'VITE_SUPABASE_URL에는 유효한 HTTPS 주소만 사용할 수 있습니다.'
}

if (-not (Test-SupabasePublishableKey -Value $key)) {
    throw 'VITE_SUPABASE_PUBLISHABLE_KEY에는 sb_publishable_ 공개키 또는 role이 anon인 레거시 JWT만 사용할 수 있습니다.'
}

Write-Host '운영 공개 설정 검증을 통과했습니다.'
