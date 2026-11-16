# Stops the Agent Desk v2 server started by Start-AgentDesk.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root '.runtime\server.pid'
if (-not (Test-Path $pidFile)) { Write-Host '실행 중인 Agent Desk 기록이 없습니다.'; exit 0 }
$id = [int](Get-Content -LiteralPath $pidFile | Select-Object -First 1)
$process = Get-Process -Id $id -ErrorAction SilentlyContinue
if ($process -and $process.ProcessName -like 'node*') { Stop-Process -Id $id; Write-Host "Agent Desk를 멈췄습니다 (PID $id)." }
else { Write-Host '이미 멈춰 있습니다.' }
Remove-Item -LiteralPath $pidFile -Force
