# AIRVIX Windows ArduPlane SITL launcher.
# No administrator rights. Downloads the Mission Planner stable build into the user cache.
# Hebrew status text comes from sitl-launch-plan.mjs so this file stays encoding-safe.
param(
  [double]$HomeLat = 32.0853,
  [double]$HomeLon = 34.7818,
  [double]$HomeAlt = 15,
  [double]$HomeHdg = 90,
  [ValidateSet('plane', 'flightaxis')]
  [string]$Physics = 'plane',
  [string]$FlightAxisHost = '127.0.0.1',
  [int]$TcpPort = 5760,
  [int]$GcsUdpPort = 14550,
  [switch]$NoGcsUdp,
  [double]$Speedup = 1,
  [string]$Defaults = '',
  [switch]$Refresh
)

$ErrorActionPreference = 'Stop'
try { chcp 65001 | Out-Null } catch { }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Fail([string]$Message) {
  Write-Host $Message
  exit 1
}

function Say([string]$Message) {
  if ($Message) { Write-Host $Message }
}

$planScript = Join-Path $PSScriptRoot 'sitl-launch-plan.mjs'
if (-not (Test-Path -LiteralPath $planScript)) {
  Fail 'חסר קובץ תוכנית ההפעלה ליד הסקריפט.'
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fail 'לא נמצא נוד. התקינו אותו ואז נסו שוב.'
}

$planArgs = @(
  $planScript,
  '--home-lat', $HomeLat,
  '--home-lon', $HomeLon,
  '--home-alt', $HomeAlt,
  '--home-hdg', $HomeHdg,
  '--physics', $Physics,
  '--flightaxis-host', $FlightAxisHost,
  '--tcp-port', $TcpPort,
  '--gcs-udp-port', $GcsUdpPort,
  '--speedup', $Speedup
)
if ($NoGcsUdp) { $planArgs += '--no-gcs-udp' }
if ($Defaults) { $planArgs += @('--defaults', $Defaults) }

$planJson = & node @planArgs 2>&1
if ($LASTEXITCODE -ne 0) {
  Fail (($planJson | Out-String).Trim())
}
try {
  $plan = $planJson | Out-String | ConvertFrom-Json
} catch {
  Fail 'תוכנית ההפעלה לא חזרה תקינה.'
}

function Test-TcpPort([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $wait = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    $ok = $wait.AsyncWaitHandle.WaitOne(700, $false) -and $client.Connected
    return [bool]$ok
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

if (Test-TcpPort $plan.tcp.port) {
  Say $plan.messages.alreadyRunning
  if ($plan.gcsUdp) {
    Say ("תחנה נוספת יכולה להאזין על פורט {0}." -f $plan.gcsUdp.port)
  }
  exit 0
}

$cacheRoot = Join-Path $env:LOCALAPPDATA 'AIRVIX\sitl-cache'
$cache = Join-Path $cacheRoot $plan.cacheDirName
New-Item -ItemType Directory -Force -Path $cache | Out-Null

function Save-OfficialFile($file) {
  $dest = Join-Path $cache $file.name
  $existing = Get-Item -LiteralPath $dest -ErrorAction SilentlyContinue
  if (-not $Refresh -and $existing -and $existing.Length -ge $file.minBytes) {
    return 'cached'
  }
  $tmp = "$dest.partial"
  try {
    Invoke-WebRequest -Uri $file.url -OutFile $tmp -UseBasicParsing
  } catch {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
    if ($existing -and $existing.Length -ge $file.minBytes) { return 'offline' }
    throw
  }
  $got = Get-Item -LiteralPath $tmp
  if ($got.Length -lt $file.minBytes) {
    Remove-Item -LiteralPath $tmp -Force
    Fail $plan.messages.fileTooSmall
  }
  Move-Item -LiteralPath $tmp -Destination $dest -Force
  return 'downloaded'
}

$downloadState = 'cached'
Say $plan.messages.downloading
foreach ($file in @($plan.files)) {
  try {
    $state = Save-OfficialFile $file
  } catch {
    Say $plan.messages.downloadFailed
    Say $file.url
    Say $_.Exception.Message
    exit 1
  }
  if ($state -eq 'downloaded') { $downloadState = 'downloaded' }
  elseif ($state -eq 'offline' -and $downloadState -ne 'downloaded') { $downloadState = 'offline' }
}
if ($downloadState -eq 'cached') { Say $plan.messages.cached }
elseif ($downloadState -eq 'offline') { Say $plan.messages.offlineCache }

$binary = Join-Path $cache $plan.binary
if (-not (Test-Path -LiteralPath $binary)) {
  Fail $plan.messages.downloadFailed
}

if ($plan.physics -eq 'flightaxis') {
  Say $plan.messages.realflight
}

Say $plan.messages.starting
$stdoutLog = Join-Path $cache 'last-stdout.txt'
$stderrLog = Join-Path $cache 'last-stderr.txt'
$argv = [string[]]@($plan.argv)
try {
  $proc = Start-Process -FilePath $binary -ArgumentList $argv -WorkingDirectory $cache -PassThru -WindowStyle Normal -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
} catch {
  Say $plan.messages.processDied
  Say $_.Exception.Message
  exit 1
}

$deadline = (Get-Date).AddSeconds(20)
$portOpen = $false
while ((Get-Date) -lt $deadline) {
  if ($proc.HasExited) { break }
  if (Test-TcpPort $plan.tcp.port) { $portOpen = $true; break }
  Start-Sleep -Milliseconds 400
}

if ($proc.HasExited) {
  Say $plan.messages.processDied
  if (Test-Path -LiteralPath $stderrLog) {
    Get-Content -LiteralPath $stderrLog -Tail 30 | ForEach-Object { Write-Host $_ }
  }
  Say $stderrLog
  exit 1
}

if (-not $portOpen) {
  Say $plan.messages.portClosed
  try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
  if (Test-Path -LiteralPath $stderrLog) {
    Get-Content -LiteralPath $stderrLog -Tail 30 | ForEach-Object { Write-Host $_ }
  }
  Say $stderrLog
  exit 1
}

Say $plan.messages.running
Say ("הקונסולה מתחברת אל {0} בפורט {1}." -f $plan.tcp.host, $plan.tcp.port)
if ($plan.gcsUdp) {
  Say ("תחנה נוספת יכולה להאזין על פורט {0}." -f $plan.gcsUdp.port)
}
exit 0
