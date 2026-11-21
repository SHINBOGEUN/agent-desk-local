# Agent Desk v2 one-click update: push the commits, rebuild the dashboard, restart the server.
# Stops at the first step that fails, so a broken build never replaces a running server.
param([switch]$NoPush, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    if (-not $NoPush) {
        Write-Host '[1/4] git push ...'
        & git push
        if ($LASTEXITCODE -ne 0) { throw 'git push가 실패했습니다. 위 메시지를 확인하세요. (푸시 없이 하려면 -NoPush)' }
    } else { Write-Host '[1/4] git push 건너뜀' }

    # web/package-lock.json changed since the last install (a new package was added): install first
    $lock = Join-Path $root 'web\package-lock.json'
    $installed = Join-Path $root 'web\node_modules\.package-lock.json'
    if (-not (Test-Path $installed) -or ((Get-Item $lock).LastWriteTime -gt (Get-Item $installed).LastWriteTime)) {
        Write-Host '[2/4] 대시보드 패키지 설치 ...'
        & npm.cmd --prefix web install
        if ($LASTEXITCODE -ne 0) { throw '패키지 설치가 실패했습니다.' }
    }

    Write-Host '[2/4] 대시보드 빌드 ...'
    & npm.cmd run web:build
    if ($LASTEXITCODE -ne 0) { throw '대시보드 빌드가 실패했습니다. 서버는 그대로 두었습니다.' }

    Write-Host '[3/4] 서버 멈춤 ...'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'stop.ps1')
    Start-Sleep -Seconds 1

    Write-Host '[4/4] 서버 시작 ...'
    $startArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'start.ps1'))
    if ($NoBrowser) { $startArgs += '-NoBrowser' }
    & powershell.exe @startArgs
    if ($LASTEXITCODE -ne 0) { throw '서버 시작이 실패했습니다.' }
    Write-Host '완료했습니다.'
} finally {
    Pop-Location
}
