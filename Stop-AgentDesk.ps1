$ErrorActionPreference = 'Stop'
$deskDirectory = $PSScriptRoot
$deskPidFile = Join-Path $deskDirectory 'data\server.pid'
if (-not (Test-Path -LiteralPath $deskPidFile)) { Write-Host '시작 스크립트로 실행된 서버가 없습니다.'; exit }
$deskProcessId = [int](Get-Content -LiteralPath $deskPidFile -Raw).Trim()
$deskProcessInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $deskProcessId" -ErrorAction SilentlyContinue
if ($deskProcessInfo -and $deskProcessInfo.Name -eq 'node.exe' -and $deskProcessInfo.CommandLine.Contains((Join-Path $deskDirectory 'server.mjs'))) {
    # Cancel active tasks over the application protocol before stopping the owned server.
    try {
        $deskState = Invoke-RestMethod -Uri 'http://127.0.0.1:4317/api/state' -TimeoutSec 2
        Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:4317/api/shutdown' -Headers @{ 'X-Agent-Desk-Token' = $deskState.csrf } -ContentType 'application/json' -Body '{}' | Out-Null
        for ($deskAttempt = 0; $deskAttempt -lt 20; $deskAttempt++) {
            if (-not (Get-Process -Id $deskProcessId -ErrorAction SilentlyContinue)) { break }
            Start-Sleep -Milliseconds 250
        }
    } catch {}
    if (Get-Process -Id $deskProcessId -ErrorAction SilentlyContinue) {
        $deskChildren = Get-CimInstance Win32_Process -Filter "ParentProcessId = $deskProcessId" -ErrorAction SilentlyContinue
        foreach ($deskChild in $deskChildren) { Stop-Process -Id $deskChild.ProcessId -ErrorAction SilentlyContinue }
        Stop-Process -Id $deskProcessId -ErrorAction SilentlyContinue
    }
}
Remove-Item -LiteralPath $deskPidFile -ErrorAction SilentlyContinue
Write-Host 'Agent Desk를 종료했습니다.'
