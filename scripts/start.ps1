# Agent Desk v2 one-click start: installs and builds the dashboard when needed,
# starts the local server in the background and opens the browser.
param([switch]$NoBrowser, [switch]$Rebuild)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path -Parent $PSScriptRoot
$port = if ($env:AGENT_DESK_PORT) { $env:AGENT_DESK_PORT } else { '4317' }
$url = "http://127.0.0.1:$port"
$runtimeDir = Join-Path $root '.runtime'
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

function Test-Desk { try { (Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 2).ok -eq $true } catch { $false } }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js가 없습니다. https://nodejs.org 에서 22.18 이상을 설치한 뒤 다시 실행하세요.' }
$version = (& node -p "process.versions.node").Trim()
$parts = $version.Split('.') | ForEach-Object { [int]$_ }
if ($parts[0] -lt 22 -or ($parts[0] -eq 22 -and $parts[1] -lt 18)) { throw "Node.js $version 입니다. 22.18 이상이 필요합니다." }

if (Test-Desk) {
    Write-Host "Agent Desk가 이미 실행 중입니다: $url"
    if (-not $NoBrowser) { Start-Process $url }
    exit 0
}

Push-Location $root
try {
    if (-not (Test-Path (Join-Path $root 'web\node_modules'))) {
        Write-Host '대시보드 패키지를 설치합니다 (처음 한 번)...'
        & npm.cmd --prefix web install
        if ($LASTEXITCODE -ne 0) { throw 'npm install에 실패했습니다.' }
    }
    $dist = Join-Path $root 'web\dist\index.html'
    $needBuild = $Rebuild -or -not (Test-Path $dist)
    if (-not $needBuild) {
        $built = (Get-Item $dist).LastWriteTime
        $newest = Get-ChildItem -Path (Join-Path $root 'web\src'), (Join-Path $root 'web\index.html') -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        $needBuild = $newest -and $newest.LastWriteTime -gt $built
    }
    if ($needBuild) {
        Write-Host '대시보드를 빌드합니다...'
        & npm.cmd run web:build
        if ($LASTEXITCODE -ne 0) { throw '대시보드 빌드에 실패했습니다. 위의 오류를 확인하세요.' }
    }
    $log = Join-Path $runtimeDir 'server.log'
    $errorLog = Join-Path $runtimeDir 'server-error.log'
    $process = Start-Process -FilePath $node.Source -ArgumentList 'packages/cli/src/bin.ts', 'serve', '--port', $port -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $errorLog -PassThru
    Set-Content -LiteralPath (Join-Path $runtimeDir 'server.pid') -Value $process.Id
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 250
        if (Test-Desk) { break }
        if ($process.HasExited) { break }
    }
    if (-not (Test-Desk)) { throw "Agent Desk를 시작하지 못했습니다. $errorLog 를 확인하세요." }
    Write-Host "Agent Desk가 실행 중입니다: $url"
    if (-not $NoBrowser) { Start-Process $url }
} finally { Pop-Location }
