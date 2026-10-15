param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$deskDirectory = $PSScriptRoot
$deskUrl = 'http://127.0.0.1:4317'
$deskNode = (Get-Command node -ErrorAction Stop).Source
$deskLogDirectory = Join-Path $deskDirectory 'data'
New-Item -ItemType Directory -Path $deskLogDirectory -Force | Out-Null
$deskRunning = $false
try {
    $deskHealth = Invoke-RestMethod -Uri "$deskUrl/api/health" -TimeoutSec 2
    $deskRunning = $deskHealth.ok -eq $true
} catch {}
if (-not $deskRunning) {
    $deskServerPath = Join-Path $deskDirectory 'server.mjs'
    $deskProcess = Start-Process -FilePath $deskNode -ArgumentList ('"{0}"' -f $deskServerPath) -WorkingDirectory $deskDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $deskLogDirectory 'server.log') -RedirectStandardError (Join-Path $deskLogDirectory 'server-error.log') -PassThru
    Set-Content -LiteralPath (Join-Path $deskLogDirectory 'server.pid') -Value $deskProcess.Id
    for ($deskAttempt = 0; $deskAttempt -lt 40; $deskAttempt++) {
        Start-Sleep -Milliseconds 250
        try { $deskHealth = Invoke-RestMethod -Uri "$deskUrl/api/health" -TimeoutSec 1; if ($deskHealth.ok) { $deskRunning = $true; break } } catch {}
        if ($deskProcess.HasExited) { break }
    }
}
if (-not $deskRunning) { throw 'Agent Desk를 시작하지 못했습니다. data\server-error.log를 확인해 주세요.' }
if (-not $NoBrowser) { Start-Process $deskUrl }
Write-Host "Agent Desk가 실행 중입니다: $deskUrl"
