# Why: a stale node process keeps port 4010 so the browser loads old JS/API (e.g. gemini-1.5-flash 404).
# What: stops whichever process is listening on PORT (default 4010), then runs npm run start from repo root.
$ErrorActionPreference = 'Continue'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot
$port = 4010
if ($env:PORT -match '^\d+$') { $port = [int]$env:PORT }
$listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
foreach ($c in $listeners) {
  $procId = $c.OwningProcess
  $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -eq 'node') {
    Write-Host "Stopping node PID $procId (listening on port $port)"
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  }
}
Start-Sleep -Milliseconds 500
npm run start
