<#
  AIRVIX ground console - Windows installer / updater
  ---------------------------------------------------
  * Installs Node.js LTS when missing. Tailscale is NOT installed and its TUN service is NOT enabled.
  * If Tailscale is already installed, a SYSTEM boot task runs tailscaled in userspace
    (SOCKS localhost:1055). That avoids the Windows DNS Client hang from a TUN install.
  * Does not edit the hosts file, DNS servers, or NRPT rules.
  * Downloads vision-landing-console (branch master) to %LOCALAPPDATA%\AIRVIX\console
    (keeps .env, data\ and var\ on update), runs "npm ci".
  * Asks ONCE (masked) for secrets and stores them only in the local .env.
  * Writes JETSON_COMPANION_BASE_URL and JETSON_COMPANION_BASE_URLS as home LAN, then Tailscale.
  * Writes JETSON_COMPANION_SOCKS_PROXY and JETSON_SOCKS_PROXY for userspace Tailscale.
  * Creates desktop shortcuts "AIRVIX" and "AIRVIX Update".

  No secrets are embedded in this file. Keep this file ASCII-only
  (Windows PowerShell 5.1 reads BOM-less scripts as ANSI).

  Usage (normally via Install-AIRVIX.bat):
    powershell -NoProfile -ExecutionPolicy Bypass -File install-airvix.ps1 [-UpdateOnly]
#>
[CmdletBinding()]
param(
    [string]$UserLocalAppData = '',
    [string]$UserDesktop = '',
    [switch]$UpdateOnly,
    [switch]$Rollback,
    [switch]$ElevatedChild
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar in PS 5.1
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { $OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

# ------------------------------------------------------------------ constants
$RepoZipUrl        = 'https://codeload.github.com/royshiber/vision-landing-console/zip/refs/heads/master'
$JetsonIp          = '100.82.59.45'
$CompanionPort     = 8081
$HomeCompanionUrl  = 'http://192.168.1.122:8081'
$TailscaleCompanionUrl = "http://${JetsonIp}:${CompanionPort}"
$CompanionCandidates = @($HomeCompanionUrl, $TailscaleCompanionUrl)
$CompanionBaseUrl  = ($CompanionCandidates -join ',')
$JetsonSocksProxy  = 'socks5h://127.0.0.1:1055'
$JetsonCompanionSocksProxy = 'socks5://127.0.0.1:1055'
$TailscaleTaskName = 'AIRVIX-Tailscale-Safe'
$RelayPort         = 5770            # console derives relay host from JETSON_COMPANION_BASE_URL + default 5770
$TailnetSuffix     = 'tail8fb31b.ts.net'
$DefaultPort       = 4010            # server.js default (PORT)
$NodeMinMajor      = 20              # better-sqlite3 12.8 prebuilds: Node 20..25
$NodeMaxMajor      = 25
$NodeFallbackMajor = 24              # used for the MSI fallback download

# ------------------------------------------------------------------ paths
if (-not $UserLocalAppData) { $UserLocalAppData = [Environment]::GetFolderPath('LocalApplicationData') }
if (-not $UserDesktop)      { $UserDesktop      = [Environment]::GetFolderPath('Desktop') }
$UserLocalAppData = $UserLocalAppData.TrimEnd('\')
$UserDesktop      = $UserDesktop.TrimEnd('\')
$Root       = Join-Path $UserLocalAppData 'AIRVIX'
$AppDir     = Join-Path $Root 'console'
$EnvFile    = Join-Path $AppDir '.env'
$EnvBackup  = Join-Path $Root '.env.backup'
$StartBat   = Join-Path $Root 'start-airvix.bat'
$UpdateBat  = Join-Path $Root 'update-airvix.bat'
$InstalledScript = Join-Path $Root 'install-airvix.ps1'
$LogFile    = Join-Path $Root 'install.log'

# results for the final summary: list of [Name, Status(PASS/FAIL/WARN/SKIP), Detail]
$Summary = New-Object System.Collections.ArrayList

# ------------------------------------------------------------------ output helpers
function Write-Step([string]$m) { Write-Host ''; Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok([string]$m)   { Write-Host "    [OK]   $m" -ForegroundColor Green }
function Write-Info([string]$m) { Write-Host "    $m" }
function Write-Wrn([string]$m)  { Write-Host "    [WARN] $m" -ForegroundColor Yellow }
function Write-Bad([string]$m)  { Write-Host "    [FAIL] $m" -ForegroundColor Red }
function Add-Result([string]$Name, [string]$Status, [string]$Detail) {
    [void]$Summary.Add([pscustomobject]@{ Name = $Name; Status = $Status; Detail = $Detail })
}

function Test-Admin {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $false }
}

# Run a native exe, show its output, return its exit code (no terminating errors on stderr in PS 5.1).
function Invoke-Native([string]$Exe, [string[]]$Arguments) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Exe @Arguments | Out-Host
        return $LASTEXITCODE
    } finally { $ErrorActionPreference = $old }
}

# Run a native exe quietly and return stdout as one string (stderr discarded).
function Get-NativeOutput([string]$Exe, [string[]]$Arguments) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $Exe @Arguments 2>$null | Out-String
        return $out
    } catch { return '' } finally { $ErrorActionPreference = $old }
}

function Update-PathFromRegistry {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @()
    foreach ($p in @($machine, $user)) { if ($p) { $parts += $p } }
    foreach ($extra in @((Join-Path $env:ProgramFiles 'nodejs'), (Join-Path $env:ProgramFiles 'Tailscale'))) {
        if ((Test-Path -LiteralPath $extra) -and (($parts -join ';') -notlike "*$extra*")) { $parts += $extra }
    }
    if ($parts.Count -gt 0) { $env:Path = ($parts -join ';') }
}

function Get-File([string]$Url, [string]$OutFile) {
    $last = $null
    for ($i = 1; $i -le 3; $i++) {
        try {
            Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
            if ((Test-Path -LiteralPath $OutFile) -and ((Get-Item -LiteralPath $OutFile).Length -gt 0)) { return }
        } catch { $last = $_; Write-Wrn "Download attempt $i failed: $($_.Exception.Message)"; Start-Sleep -Seconds (2 * $i) }
    }
    throw "Download failed: $Url ($last)"
}

function Get-CpuArch {
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { return 'arm64' }
    return 'x64'
}

function Install-Msi([string]$MsiPath) {
    $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', ('"' + $MsiPath + '"'), '/qn', '/norestart') -Wait -PassThru
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw "msiexec failed with exit code $($p.ExitCode) for $MsiPath" }
}

function Install-WithWinget([string]$Id) {
    $wg = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $wg) { Write-Wrn 'winget is not available - using the official MSI instead.'; return }
    Write-Info "winget install $Id ..."
    $code = Invoke-Native $wg.Source @('install', '--id', $Id, '-e', '--source', 'winget', '--silent',
        '--accept-package-agreements', '--accept-source-agreements')
    Write-Info "winget exit code: $code"
}

# ------------------------------------------------------------------ Node.js
function Get-NodeExe {
    $c = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    $p = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    if (Test-Path -LiteralPath $p) { return $p }
    return $null
}
function Get-NodeVersion([string]$NodeExe) {
    if (-not $NodeExe) { return $null }
    $v = (Get-NativeOutput $NodeExe @('--version')).Trim()
    if ($v -match '^v(\d+)\.(\d+)\.(\d+)') { return [version]("{0}.{1}.{2}" -f $Matches[1], $Matches[2], $Matches[3]) }
    return $null
}
function Test-NodeOk {
    $exe = Get-NodeExe
    $ver = Get-NodeVersion $exe
    return ($ver -and $ver.Major -ge $NodeMinMajor -and $ver.Major -le $NodeMaxMajor)
}
function Install-Node {
    Write-Step 'Installing Node.js LTS'
    Install-WithWinget 'OpenJS.NodeJS.LTS'
    Update-PathFromRegistry
    if (Test-NodeOk) { Write-Ok "Node.js $(Get-NodeVersion (Get-NodeExe)) installed (winget)"; return }
    Write-Info "Falling back to the official Node.js $NodeFallbackMajor MSI from nodejs.org ..."
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
    $rel = $index | Where-Object { $_.lts -and ($_.version -like "v$NodeFallbackMajor.*") } | Select-Object -First 1
    if (-not $rel) { throw "Could not find a Node.js v$NodeFallbackMajor LTS release on nodejs.org" }
    $ver = $rel.version
    $arch = Get-CpuArch
    $msi = Join-Path $env:TEMP "node-$ver-$arch.msi"
    Get-File "https://nodejs.org/dist/$ver/node-$ver-$arch.msi" $msi
    Install-Msi $msi
    Remove-Item -LiteralPath $msi -Force -ErrorAction SilentlyContinue
    Update-PathFromRegistry
    if (-not (Test-NodeOk)) { throw 'Node.js installation failed (node.exe not found or unsupported version).' }
    Write-Ok "Node.js $(Get-NodeVersion (Get-NodeExe)) installed (MSI)"
}

# ------------------------------------------------------------------ Tailscale
function Get-TailscaleExe {
    $c = Get-Command tailscale.exe -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    foreach ($p in @((Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'), (Join-Path ${env:ProgramFiles(x86)} 'Tailscale\tailscale.exe'))) {
        if ($p -and (Test-Path -LiteralPath $p)) { return $p }
    }
    return $null
}
function Get-TailscaledExe([string]$TsExe) {
    if (-not $TsExe) { return $null }
    $daemon = Join-Path (Split-Path -Parent $TsExe) 'tailscaled.exe'
    if (Test-Path -LiteralPath $daemon) { return $daemon }
    return $null
}
function Get-UserspaceAdminPrompt {
    # Hebrew prompt. Code points keep this file ASCII for Windows PowerShell 5.1.
    $codes = @(
        1504,1491,1512,1513,1493,1514,32,1492,1512,1513,1488,1493,1514,32,1502,1504,1492,1500,46,32,
        1502,1510,1489,32,1512,1490,1497,1500,32,1514,1493,1511,1506,32,1488,1514,32,1513,1497,1512,1493,1514,32,1492,1513,1502,1493,1514,46,32,
        1504,1508,1506,1497,1500,32,1502,1510,1489,32,1502,1513,1514,1502,1513,32,1489,1500,1497,32,1502,1514,1488,1501,32,1512,1513,1514,46,32,
        1488,1513,1512,1493,32,1488,1514,32,1492,1495,1500,1493,1503,46
    )
    return -join ($codes | ForEach-Object { [char]$_ })
}
function Test-CgnatIp([string]$HostName) {
    $name = $HostName.Trim().ToLower()
    if ($name.StartsWith('::ffff:')) { $name = $name.Substring(7) }
    $parts = $name.Split('.')
    if ($parts.Count -ne 4) { return $false }
    $oct = @()
    foreach ($p in $parts) {
        $n = 0
        if (-not [int]::TryParse($p, [ref]$n)) { return $false }
        if ($n -lt 0 -or $n -gt 255) { return $false }
        $oct += $n
    }
    return ($oct[0] -eq 100 -and $oct[1] -ge 64 -and $oct[1] -le 127)
}
function Test-AirvixTailscaleTask {
    $out = Get-NativeOutput 'schtasks.exe' @('/Query', '/TN', $TailscaleTaskName)
    return [bool]($out -and ($out -like "*$TailscaleTaskName*"))
}
function Test-TailscaleServiceDisabled {
    $svc = Get-Service -Name 'Tailscale' -ErrorAction SilentlyContinue
    if (-not $svc) { return $true }
    return [string]$svc.StartType -eq 'Disabled'
}
function Test-UserspaceReady([string]$TsExe) {
    return (Get-TailscaledExe $TsExe) -and (Test-AirvixTailscaleTask) -and (Test-TailscaleServiceDisabled)
}
function Disable-TailscaleTunService {
    # Stop and disable the TUN service only. Never edit hosts, DNS, or NRPT.
    $svc = Get-Service -Name 'Tailscale' -ErrorAction SilentlyContinue
    if (-not $svc) { return }
    try { Stop-Service -Name 'Tailscale' -Force -ErrorAction Stop } catch { Write-Wrn 'Could not stop the Tailscale service. It will be set to Disabled.' }
    Set-Service -Name 'Tailscale' -StartupType Disabled
    Write-Ok 'Tailscale service Disabled (userspace task will carry the link)'
}
function Enable-AirvixTailscaleUserspace([string]$TsExe) {
    $daemon = Get-TailscaledExe $TsExe
    if (-not $daemon) { throw 'tailscaled.exe was not found next to tailscale.exe' }
    if (-not (Test-Admin)) { throw 'Administrator rights are required for userspace Tailscale' }
    Disable-TailscaleTunService
    $tr = '"' + $daemon + '" --tun=userspace-networking --socks5-server=localhost:1055 --outbound-http-proxy-listen=localhost:1056'
    $code = Invoke-Native 'schtasks.exe' @('/Create', '/F', '/TN', $TailscaleTaskName, '/SC', 'ONSTART', '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/TR', $tr)
    if ($code -ne 0) { throw "Could not create scheduled task $TailscaleTaskName (exit $code)" }
    $run = Invoke-Native 'schtasks.exe' @('/Run', '/TN', $TailscaleTaskName)
    if ($run -ne 0) { throw "Could not start scheduled task $TailscaleTaskName (exit $run)" }
    Write-Ok "Userspace Tailscale task $TailscaleTaskName is running (SOCKS localhost:1055)"
    return $true
}
function Set-JetsonSocksProxyInEnv {
    $lines = Read-EnvLines
    Set-EnvValue $lines 'JETSON_SOCKS_PROXY' $JetsonSocksProxy
    Set-EnvValue $lines 'JETSON_COMPANION_SOCKS_PROXY' $JetsonCompanionSocksProxy
    Save-EnvLines $lines
    Write-Ok "JETSON_SOCKS_PROXY=$JetsonSocksProxy"
    Write-Ok "JETSON_COMPANION_SOCKS_PROXY=$JetsonCompanionSocksProxy"
}
function Get-TailscaleStatus([string]$TsExe) {
    $raw = Get-NativeOutput $TsExe @('status', '--json')
    if (-not $raw -or -not $raw.Trim()) { return $null }
    try { return ($raw | ConvertFrom-Json) } catch { return $null }
}
function Get-TailnetSuffix($st) {
    if (-not $st) { return '' }
    $s = ''
    if ($st.PSObject.Properties['CurrentTailnet'] -and $st.CurrentTailnet -and $st.CurrentTailnet.PSObject.Properties['MagicDNSSuffix']) { $s = [string]$st.CurrentTailnet.MagicDNSSuffix }
    if (-not $s -and $st.PSObject.Properties['MagicDNSSuffix']) { $s = [string]$st.MagicDNSSuffix }
    return $s
}
function Open-Url([string]$Url) {
    # When elevated, hand the URL to the (non-elevated) shell so the browser does not run as admin.
    if (Test-Admin) { Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $Url + '"') }
    else { Start-Process -FilePath $Url }
}
function Connect-Tailscale([string]$TsExe) {
    # Talks to the userspace daemon. Does not start or enable the Tailscale TUN service.
    $st = Get-TailscaleStatus $TsExe
    if (-not $st) {
        Write-Info 'Userspace Tailscale is not answering yet.'
        for ($i = 0; $i -lt 8 -and -not $st; $i++) { Start-Sleep -Seconds 2; $st = Get-TailscaleStatus $TsExe }
    }
    $state = ''; if ($st) { $state = [string]$st.BackendState }
    if ($state -eq 'Running') { return $st }

    Write-Info "Tailscale state: '$state' - signing in through the userspace daemon ..."
    Write-Host ''
    Write-Host '    A browser page will open. Sign in with the SAME account that owns the' -ForegroundColor Yellow
    Write-Host "    AIRVIX tailnet ($TailnetSuffix, Jetson = $JetsonIp). Waiting up to 5 minutes ..." -ForegroundColor Yellow
    $outF = Join-Path $env:TEMP ('airvix-ts-out-' + [guid]::NewGuid().ToString('N') + '.txt')
    $errF = Join-Path $env:TEMP ('airvix-ts-err-' + [guid]::NewGuid().ToString('N') + '.txt')
    $proc = Start-Process -FilePath $TsExe -ArgumentList @('up', '--timeout=300s') -NoNewWindow -PassThru `
        -RedirectStandardOutput $outF -RedirectStandardError $errF
    $opened = $false
    $deadline = (Get-Date).AddSeconds(310)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        if (-not $opened) {
            $txt = ''
            foreach ($f in @($outF, $errF)) { if (Test-Path -LiteralPath $f) { $txt += (Get-Content -LiteralPath $f -Raw -ErrorAction SilentlyContinue) } }
            if ($txt -match '(https://login\.tailscale\.com/\S+)') {
                $url = $Matches[1]
                Write-Info "Opening Tailscale login: $url"
                try { Open-Url $url } catch { Write-Wrn "Could not open the browser. Open this URL manually: $url" }
                $opened = $true
            }
        }
        $st = Get-TailscaleStatus $TsExe
        if ($st -and [string]$st.BackendState -eq 'Running') { break }
        if ($proc.HasExited -and -not ($st -and [string]$st.BackendState -eq 'Running')) {
            Start-Sleep -Seconds 2
            $st = Get-TailscaleStatus $TsExe
            break
        }
    }
    if (-not $proc.HasExited) { try { $proc.Kill() } catch { } }
    if (-not ($st -and [string]$st.BackendState -eq 'Running')) {
        $errTxt = ''
        if (Test-Path -LiteralPath $errF) { $errTxt = (Get-Content -LiteralPath $errF -Raw -ErrorAction SilentlyContinue) }
        if ($errTxt) { Write-Wrn ("tailscale up said: " + $errTxt.Trim()) }
        Write-Wrn 'Tailscale is not connected. Click the Tailscale tray icon (near the clock) -> Log in, then re-run the installer.'
    }
    Remove-Item -LiteralPath $outF, $errF -Force -ErrorAction SilentlyContinue
    return $st
}

# ------------------------------------------------------------------ console server helpers
function Get-EnvPort {
    $port = $DefaultPort
    if (Test-Path -LiteralPath $EnvFile) {
        $v = Get-EnvValue (Read-EnvLines) 'PORT'
        if ($v -match '^\d{2,5}$') { $port = [int]$v }
    }
    return $port
}
function Stop-AirvixServer([int]$Port) {
    $owners = @()
    try { $owners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique) } catch { }
    foreach ($procId in $owners) {
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if (-not $proc) { continue }
        if ($proc.ProcessName -eq 'node') {
            Write-Info "Stopping running AIRVIX server (node PID $procId on port $Port) ..."
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        } else {
            Write-Wrn "Port $Port is used by '$($proc.ProcessName)' (PID $procId). AIRVIX needs this port; change PORT in $EnvFile if this persists."
        }
    }
}

# ------------------------------------------------------------------ download / deploy
function Copy-CodeTree([string]$From, [string]$To) {
    if (-not (Test-Path -LiteralPath $From)) { return }
    New-Item -ItemType Directory -Path $To -Force | Out-Null
    $code = Invoke-Native 'robocopy.exe' @($From, $To, '/MIR', '/XD', 'node_modules', 'data', 'var', '.git',
        '/XF', '.env', '/R:2', '/W:2', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    if ($code -ge 8) { throw "robocopy failed (exit $code) while copying $From" }
}
function Write-UpdateStatus([string]$State, [string]$ErrorText) {
    try {
        $p = Join-Path $Root 'update-status.json'
        $payload = [ordered]@{ state = $State; error = [string]$ErrorText; logPath = $LogFile }
        $json = $payload | ConvertTo-Json -Compress
        [IO.File]::WriteAllText($p, $json, (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}
$script:restartedAfterFailure = $false
function Start-ExistingAirvixServer {
    if ($script:restartedAfterFailure) { return }
    $script:restartedAfterFailure = $true
    $bat = Join-Path $Root 'run-server.bat'
    if (-not (Test-Path -LiteralPath $bat)) { return }
    if (-not (Test-Path -LiteralPath (Join-Path $AppDir 'server.js'))) { return }
    Write-Info 'Starting the previous AIRVIX server again ...'
    Start-Process -FilePath $bat -WindowStyle Minimized
}
function Update-ConsoleFiles {
    $tmp = Join-Path $env:TEMP ('airvix-dl-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    try {
        $zip = Join-Path $tmp 'master.zip'
        Write-Info "Downloading $RepoZipUrl ..."
        Get-File $RepoZipUrl $zip
        Write-Info 'Extracting ...'
        # Expand-Archive aborts on entries whose names are illegal on Windows
        # (e.g. Linux usb-modeswitch files named '12d1:14fe'). Extract entry by
        # entry and skip those; they are only used on the Jetson.
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $bad = [char[]]':*?"<>|'
        $skipped = 0
        $za = [System.IO.Compression.ZipFile]::OpenRead($zip)
        try {
            foreach ($e in $za.Entries) {
                $rel = $e.FullName
                if ($rel.IndexOfAny($bad) -ge 0) { $skipped++; continue }
                $dest = Join-Path $tmp ($rel -replace '/', '\')
                if ($rel.EndsWith('/')) { New-Item -ItemType Directory -Path $dest -Force | Out-Null; continue }
                $dir = Split-Path -Parent $dest
                if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
                [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $true)
            }
        } finally { $za.Dispose() }
        if ($skipped) { Write-Info "Skipped $skipped Jetson-only file(s) with names Windows cannot store." }
        $src = Get-ChildItem -LiteralPath $tmp -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'server.js') } | Select-Object -First 1
        if (-not $src) { throw 'Downloaded archive does not contain server.js' }

        New-Item -ItemType Directory -Path $AppDir -Force | Out-Null
        if (Test-Path -LiteralPath $EnvFile) { Copy-Item -LiteralPath $EnvFile -Destination $EnvBackup -Force }

        $rollback = Join-Path $Root 'rollback'
        $hadApp = Test-Path -LiteralPath (Join-Path $AppDir 'server.js')
        if ($hadApp) {
            Write-Info "Saving a rollback copy to $rollback"
            Copy-CodeTree $AppDir $rollback
        }

        # Mirror code; keep local-only items (.env, node_modules, data, var) out of the purge.
        $script:updateTouchedApp = $true
        $code = Invoke-Native 'robocopy.exe' @($src.FullName, $AppDir, '/MIR', '/XD', 'node_modules', 'data', 'var', '.git',
            '/XF', '.env', '/R:2', '/W:2', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
        if ($code -ge 8) { throw "robocopy failed (exit $code) while copying console files" }
        # Tracked files under data\ are updated, local DB / uploads are never deleted (no purge).
        $srcData = Join-Path $src.FullName 'data'
        if (Test-Path -LiteralPath $srcData) {
            $code = Invoke-Native 'robocopy.exe' @($srcData, (Join-Path $AppDir 'data'), '/E', '/R:2', '/W:2', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
            if ($code -ge 8) { throw "robocopy failed (exit $code) while copying data files" }
        }
        if (-not (Test-Path -LiteralPath $EnvFile) -and (Test-Path -LiteralPath $EnvBackup)) {
            Copy-Item -LiteralPath $EnvBackup -Destination $EnvFile -Force
            Write-Info 'Restored .env from backup.'
        }
        if ((Test-Path -LiteralPath $EnvFile) -and (Test-Path -LiteralPath $EnvBackup)) {
            Remove-Item -LiteralPath $EnvBackup -Force -ErrorAction SilentlyContinue
        }
    } catch {
        $rollback = Join-Path $Root 'rollback'
        if ($script:updateTouchedApp -and (Test-Path -LiteralPath (Join-Path $rollback 'server.js'))) {
            Write-Wrn 'Update failed before it finished - restoring the previous console code.'
            Copy-CodeTree $rollback $AppDir
        }
        throw
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-NpmCi([string]$NodeExe) {
    $npm = Join-Path (Split-Path -Parent $NodeExe) 'npm.cmd'
    if (-not (Test-Path -LiteralPath $npm)) {
        $c = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if ($c) { $npm = $c.Source } else { throw 'npm.cmd not found next to node.exe' }
    }
    $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
    Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue   # devDependencies are needed (vendor-sync postinstall)
    Push-Location -LiteralPath $AppDir
    try {
        for ($i = 1; $i -le 2; $i++) {
            $code = Invoke-Native $npm @('ci', '--no-audit', '--no-fund', '--loglevel', 'error')
            if ($code -eq 0) { return }
            Write-Wrn "npm ci failed (exit $code), attempt $i."
            if ($i -eq 1) { Stop-AirvixServer (Get-EnvPort); Start-Sleep -Seconds 3 }
        }
        throw 'npm ci failed. Close any running AIRVIX Server window / antivirus scan and run the installer again.'
    } finally { Pop-Location }
}

# ------------------------------------------------------------------ .env handling
function Read-EnvLines {
    if (-not (Test-Path -LiteralPath $EnvFile)) { return ,(New-Object System.Collections.ArrayList) }
    $list = New-Object System.Collections.ArrayList
    foreach ($l in [IO.File]::ReadAllLines($EnvFile)) { [void]$list.Add($l) }
    return ,$list
}
function Get-EnvValue($Lines, [string]$Key) {
    $rx = '^\s*(?:export\s+)?' + [regex]::Escape($Key) + '\s*=(.*)$'
    foreach ($l in $Lines) {
        if ($l -match $rx) {
            $v = $Matches[1].Trim()
            if ($v.Length -ge 2 -and (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'")))) { $v = $v.Substring(1, $v.Length - 2) }
            return $v
        }
    }
    return ''
}
function Format-EnvValue([string]$v) {
    if ($v -match '[\s#"''`\\]') {
        if ($v -notmatch "'") { return "'" + $v + "'" }
        return '"' + ($v -replace '"', '\"') + '"'
    }
    return $v
}
function Set-EnvValue($Lines, [string]$Key, [string]$Value) {
    $rx = '^\s*(?:export\s+)?' + [regex]::Escape($Key) + '\s*='
    $newLine = $Key + '=' + (Format-EnvValue $Value)
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i] -match $rx) { $Lines[$i] = $newLine; return }
    }
    [void]$Lines.Add($newLine)
}
function Save-EnvLines($Lines) {
    $text = (($Lines | ForEach-Object { [string]$_ }) -join "`r`n") + "`r`n"
    [IO.File]::WriteAllText($EnvFile, $text, (New-Object System.Text.UTF8Encoding($false)))   # no BOM (dotenv)
}
function Read-Secret([string]$Prompt) {
    $sec = Read-Host -Prompt $Prompt -AsSecureString
    if ($null -eq $sec -or $sec.Length -eq 0) { return '' }
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    $plain = $plain.Trim()
    if ($plain.Length -ge 2 -and (($plain.StartsWith('"') -and $plain.EndsWith('"')) -or ($plain.StartsWith("'") -and $plain.EndsWith("'")))) { $plain = $plain.Substring(1, $plain.Length - 2).Trim() }
    return $plain
}
function Set-SecretInteractive($Lines, [string]$Key, [string]$Label, [bool]$Required) {
    $existing = Get-EnvValue $Lines $Key
    if ($existing) {
        $ans = Read-Host "    $Label is already saved. Replace it? [y/N]"
        if ($ans -notmatch '^\s*(y|yes)\s*$') { Write-Ok "$Label - keeping the saved value"; return }
    }
    while ($true) {
        if ($Required) { $prompt = "    Paste $Label (hidden, required)" }
        else { $prompt = "    Paste $Label (hidden, optional - press Enter to skip)" }
        $v = Read-Secret $prompt
        if ($v) { Set-EnvValue $Lines $Key $v; Write-Ok "$Label saved to local .env"; return }
        if ($existing) { Write-Ok "$Label - keeping the saved value"; return }
        if (-not $Required) {
            if (-not ($Lines -match ('^\s*' + [regex]::Escape($Key) + '\s*='))) { Set-EnvValue $Lines $Key '' }
            Write-Info "$Label skipped (you can re-run the installer later to add it)."
            return
        }
        Write-Wrn "$Label is required for the field connection to the Jetson."
    }
}
function Update-EnvFile([bool]$Interactive) {
    $lines = Read-EnvLines
    $isNew = ($lines.Count -eq 0)
    if ($isNew) {
        [void]$lines.Add('# AIRVIX ground console - local settings (written by install-airvix.ps1). Contains secrets: do not share.')
    }
    $port = Get-EnvValue $lines 'PORT'
    if ($port -notmatch '^\d{2,5}$') { Set-EnvValue $lines 'PORT' ([string]$DefaultPort) }
    Set-EnvValue $lines 'HOST' '127.0.0.1'
    Set-EnvValue $lines 'COMPANION_MODE' 'real'
    Set-EnvValue $lines 'JETSON_COMPANION_BASE_URL' $CompanionBaseUrl
    Set-EnvValue $lines 'JETSON_COMPANION_BASE_URLS' $CompanionBaseUrl
    Set-EnvValue $lines 'JETSON_COMPANION_SOCKS_PROXY' $JetsonCompanionSocksProxy
    Set-EnvValue $lines 'JETSON_SOCKS_PROXY' $JetsonSocksProxy
    Set-EnvValue $lines 'COMPANION_TIMEOUT_MS' '8000'
    if ($Interactive -or -not (Get-EnvValue $lines 'JETSON_COMPANION_TOKEN')) {
        Write-Info 'Secrets are stored ONLY in the local file below (never uploaded):'
        Write-Info "  $EnvFile"
        Set-SecretInteractive $lines 'JETSON_COMPANION_TOKEN' 'Jetson companion token (JETSON_COMPANION_TOKEN)' $true
    }
    if ($Interactive) {
        Set-SecretInteractive $lines 'GEMINI_API_KEY' 'Gemini API key (GEMINI_API_KEY)' $false
        Set-SecretInteractive $lines 'ELEVENLABS_API_KEY' 'ElevenLabs API key (ELEVENLABS_API_KEY)' $false
    }
    Save-EnvLines $lines
    return $lines
}

# ------------------------------------------------------------------ launchers + shortcuts
function Write-AsciiFile([string]$Path, [string]$Text) {
    $Text = $Text -replace "`r?`n", "`r`n"
    [IO.File]::WriteAllText($Path, $Text, [System.Text.Encoding]::ASCII)
}
function Write-Launchers {
    # start-airvix.bat : start node minimized if the port is not already listening, wait, open browser.
    $start = @'
@echo off
rem AIRVIX console launcher (generated by install-airvix.ps1). Works with spaces in paths.
chcp 65001 >nul
setlocal EnableExtensions
title AIRVIX launcher
set "APPDIR=%~dp0console"
set "PORT=4010"
if not exist "%APPDIR%\server.js" goto :noapp
if not exist "%APPDIR%\.env" goto :portdone
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%APPDIR%\.env") do if /i "%%A"=="PORT" set "PORT=%%B"
:portdone
set "PORT=%PORT: =%"

set "NODE_EXE="
for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE goto :nonode

call :is_listening
if "%LISTENING%"=="1" goto :open

echo Starting AIRVIX console server on http://127.0.0.1:%PORT%/ ...
start "AIRVIX Server" /min "%~dp0run-server.bat"

set /a WAITED=0
:wait
call :is_listening
if "%LISTENING%"=="1" goto :open
set /a WAITED+=1
if %WAITED% geq 90 goto :fail
ping -n 2 127.0.0.1 >nul
goto :wait

:open
echo AIRVIX console is running - opening the browser ...
start "" "http://127.0.0.1:%PORT%/"
ping -n 3 127.0.0.1 >nul
exit /b 0

:is_listening
set "LISTENING=0"
rem Locale-independent: a listening socket has foreign address 0.0.0.0:0 (state text is translated on non-English Windows).
netstat -an -p TCP | findstr /r /c:":%PORT%  *0\.0\.0\.0:0 " >nul 2>&1 && set "LISTENING=1"
if "%LISTENING%"=="1" exit /b 0
where curl.exe >nul 2>&1 || exit /b 0
curl.exe -s -o nul -m 2 "http://127.0.0.1:%PORT%/" >nul 2>&1 && set "LISTENING=1"
exit /b 0

:fail
echo.
echo [FAIL] The AIRVIX server did not start listening on port %PORT% within 90 seconds.
echo        Open the minimized "AIRVIX Server" window on the taskbar to see the error.
pause
exit /b 1

:nonode
echo [FAIL] Node.js was not found. Run Install-AIRVIX.bat again.
pause
exit /b 1

:noapp
echo [FAIL] Console files not found in "%APPDIR%". Run Install-AIRVIX.bat again.
pause
exit /b 1
'@
    # run-server.bat : runs node in its own (minimized) window; closing that window stops the server.
    $runServer = @'
@echo off
rem AIRVIX console server (generated by install-airvix.ps1). Close this window to stop the server.
chcp 65001 >nul
title AIRVIX Server - close this window to stop
cd /d "%~dp0console"
if not defined NODE_EXE set "NODE_EXE=node.exe"
echo AIRVIX console server - folder: %CD%
"%NODE_EXE%" server.js
echo.
echo [AIRVIX] The server stopped (exit code %ERRORLEVEL%).
pause
'@
    $update = @'
@echo off
rem AIRVIX updater (generated by install-airvix.ps1): re-downloads master, runs npm ci, keeps .env and data.
chcp 65001 >nul
title AIRVIX Update
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-airvix.ps1" -UpdateOnly
echo.
pause
'@
    Write-AsciiFile $StartBat $start
    Write-AsciiFile (Join-Path $Root 'run-server.bat') $runServer
    Write-AsciiFile $UpdateBat $update
    if ($PSCommandPath -and ((Resolve-Path -LiteralPath $PSCommandPath).Path -ne $InstalledScript)) {
        Copy-Item -LiteralPath $PSCommandPath -Destination $InstalledScript -Force
    }
    try { Unblock-File -LiteralPath $InstalledScript -ErrorAction SilentlyContinue } catch { }
}
function New-Shortcut([string]$LnkPath, [string]$Target, [string]$WorkDir, [string]$Description, [string]$Icon) {
    $ws = New-Object -ComObject WScript.Shell
    $lnk = $ws.CreateShortcut($LnkPath)
    $lnk.TargetPath = $Target
    $lnk.WorkingDirectory = $WorkDir
    $lnk.Description = $Description
    $lnk.WindowStyle = 1
    if ($Icon) { $lnk.IconLocation = $Icon }
    $lnk.Save()
}

# ------------------------------------------------------------------ connectivity tests
function Test-Tcp([string]$HostName, [int]$Port, [int]$TimeoutMs) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect($HostName, $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
        $client.EndConnect($iar)
        return $client.Connected
    } catch { return $false } finally { $client.Close() }
}
function Test-CompanionHttpViaSocks([string]$Url) {
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    if (-not (Test-Path -LiteralPath $curl)) {
        $cmd = Get-Command curl.exe -ErrorAction SilentlyContinue
        if ($cmd) { $curl = $cmd.Source } else { return 0 }
    }
    $out = Join-Path $env:TEMP ('airvix-socks-' + [guid]::NewGuid().ToString('N') + '.txt')
    $codeText = & $curl --silent --show-error --socks5-hostname 'localhost:1055' --max-time 8 -o $out -w '%{http_code}' $Url
    Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
    if ($codeText -match '^\d+$') { return [int]$codeText }
    return 0
}
function Test-SocksHealthCounts([int]$Code) {
    # 401 counts as reachable: the proxy reached the Jetson and it asked for a token.
    if ($Code -eq 401 -or $Code -eq 403) { return $true }
    return ($Code -ge 200 -and $Code -lt 300)
}
function Test-CompanionHttp([string]$Url, [string]$Token) {
    # returns HTTP status code, or 0 when there is no HTTP answer at all
    try {
        $req = [System.Net.HttpWebRequest]::Create($Url)
        $req.Method = 'GET'
        $req.Timeout = 8000
        $req.ReadWriteTimeout = 8000
        if ($Token) {
            $req.Headers.Add('X-Companion-Token', $Token)
            $req.Headers.Add('Authorization', 'Bearer ' + $Token)
        }
        $resp = $req.GetResponse()
        $code = [int]$resp.StatusCode
        $resp.Close()
        return $code
    } catch {
        $ex = $_.Exception
        while ($ex -and -not ($ex -is [System.Net.WebException])) { $ex = $ex.InnerException }
        if ($ex -and $ex.Response) {
            $code = [int]$ex.Response.StatusCode
            try { $ex.Response.Close() } catch { }
            return $code
        }
        return 0
    }
}
function Invoke-ReachabilityTests([string]$Token, [bool]$UseSocks) {
    Write-Step "Testing companion addresses ($CompanionBaseUrl)"
    $anyHttp = $false
    foreach ($base in $CompanionCandidates) {
        $hostName = ''
        try { $hostName = ([uri]$base).Host } catch { $hostName = '' }
        $viaSocks = $UseSocks -and (Test-CgnatIp $hostName)
        if ($viaSocks) {
            $healthUrl = "$base/health"
            $code = 0
            for ($i = 1; $i -le 2; $i++) {
                $code = Test-CompanionHttpViaSocks $healthUrl
                if ($code -ne 0) { break }
                if ($i -lt 2) { Start-Sleep -Seconds 2 }
            }
            if (Test-SocksHealthCounts $code) {
                Write-Ok "Companion via SOCKS $base reachable (HTTP $code). 401 counts as reachable."
                Add-Result "Companion SOCKS $base" 'PASS' "HTTP $code via localhost:1055"
                $anyHttp = $true
            } else {
                Write-Wrn "No SOCKS answer from $base (HTTP $code)"
                Add-Result "Companion SOCKS $base" 'WARN' 'no answer via proxy'
            }
            continue
        }
        $healthUrl = "$base/api/v1/health"
        $code = 0
        for ($i = 1; $i -le 2; $i++) {
            $code = Test-CompanionHttp $healthUrl $Token
            if ($code -ne 0) { break }
            if ($i -lt 2) { Start-Sleep -Seconds 2 }
        }
        if ($code -ge 200 -and $code -lt 300) {
            Write-Ok "Companion HTTP $base reachable, token accepted (HTTP $code)"
            Add-Result "Companion $base" 'PASS' "HTTP $code, token accepted"
            $anyHttp = $true
        } elseif ($code -eq 401 -or $code -eq 403) {
            Write-Bad "Companion HTTP $base reachable but the token was REJECTED (HTTP $code)."
            Add-Result "Companion $base" 'FAIL' "reachable, token rejected (HTTP $code)"
            $anyHttp = $true
        } elseif ($code -ne 0) {
            Write-Wrn "Companion HTTP $base reachable, unexpected HTTP $code"
            Add-Result "Companion $base" 'WARN' "reachable, HTTP $code"
            $anyHttp = $true
        } else {
            Write-Wrn "No answer from $base"
            Add-Result "Companion $base" 'WARN' 'no answer'
        }
    }
    if (-not $anyHttp) {
        Add-Result 'Jetson companion HTTP' 'FAIL' 'no answer on any address'
    }
    if (Test-CgnatIp $JetsonIp) {
        Write-Info "MAVLink relay ${JetsonIp}:$RelayPort has no direct route in userspace mode. The console opens it through the SOCKS proxy."
        Add-Result 'Jetson MAVLink relay TCP :5770' 'PASS' 'via SOCKS when JETSON_SOCKS_PROXY is set'
        return
    }
    $tcpOk = $false
    for ($i = 1; $i -le 3; $i++) {
        $tcpOk = Test-Tcp $JetsonIp $RelayPort 5000
        if ($tcpOk) { break }
        if ($i -lt 3) { Start-Sleep -Seconds 2 }
    }
    if ($tcpOk) {
        Write-Ok "MAVLink relay TCP ${JetsonIp}:$RelayPort open"
        Add-Result 'Jetson MAVLink relay TCP :5770' 'PASS' 'port open'
    } else {
        Write-Bad "MAVLink relay TCP ${JetsonIp}:$RelayPort not reachable."
        Add-Result 'Jetson MAVLink relay TCP :5770' 'FAIL' 'no connection'
    }
}

function Show-Summary {
    Write-Host ''
    Write-Host '======================= AIRVIX INSTALL SUMMARY =======================' -ForegroundColor Cyan
    foreach ($r in $Summary) {
        $color = 'Gray'
        switch ($r.Status) { 'PASS' { $color = 'Green' } 'FAIL' { $color = 'Red' } 'WARN' { $color = 'Yellow' } }
        Write-Host ('  [{0,-4}] {1,-34} {2}' -f $r.Status, $r.Name, $r.Detail) -ForegroundColor $color
    }
    Write-Host '=======================================================================' -ForegroundColor Cyan
    $fails = @($Summary | Where-Object { $_.Status -eq 'FAIL' }).Count
    if ($fails -eq 0) {
        Write-Host '  ALL GOOD. Double-click "AIRVIX" on the desktop to start the console.' -ForegroundColor Green
    } else {
        Write-Host "  $fails check(s) FAILED - see details above. The console is installed;" -ForegroundColor Yellow
        Write-Host '  Jetson checks need the Jetson powered on and Tailscale signed in.' -ForegroundColor Yellow
    }
    Write-Host "  Install folder: $Root"
    Write-Host "  Log: $LogFile"
}

# ================================================================== main
$script:exitCode = 0
$script:transcript = $false
$script:updateTouchedApp = $false

function Invoke-Main {
    New-Item -ItemType Directory -Path $Root -Force | Out-Null
    Write-Host ''
    if ($Rollback) {
        Write-Host '  AIRVIX ground console - ROLLBACK' -ForegroundColor Cyan
        $rollback = Join-Path $Root 'rollback'
        if (-not (Test-Path -LiteralPath (Join-Path $rollback 'server.js'))) {
            Write-UpdateStatus 'failed' 'previous tree missing'
            throw 'previous tree missing'
        }
        Write-UpdateStatus 'rolling_back' ''
        Stop-AirvixServer (Get-EnvPort)
        Copy-CodeTree $rollback $AppDir
        Start-ExistingAirvixServer
        Write-UpdateStatus 'ok' ''
        Write-Host '  Restored the previous console code. Settings and data were kept.' -ForegroundColor Green
        return
    }
    if ($UpdateOnly) { Write-Host '  AIRVIX ground console - UPDATE' -ForegroundColor Cyan }
    else { Write-Host '  AIRVIX ground console - Windows installer' -ForegroundColor Cyan }
    Write-Host "  Install folder: $Root"

    # ---- 1. prerequisites (elevate only if Node is missing, or userspace Tailscale must be configured)
    Write-Step 'Checking prerequisites (Node.js, Tailscale userspace)'
    Update-PathFromRegistry
    $needNode = -not (Test-NodeOk)
    # Tailscale is never installed and its TUN service is never enabled.
    $needTs = $false
    $tsEarly = Get-TailscaleExe
    $needUserspace = [bool]($tsEarly -and -not (Test-UserspaceReady $tsEarly))
    if ($needNode) { Write-Info "Node.js $NodeMinMajor..$NodeMaxMajor not found - will install Node.js LTS." } else { Write-Ok "Node.js $(Get-NodeVersion (Get-NodeExe))" }
    if (-not $tsEarly) { Write-Info 'Tailscale not installed - skipped (not installed automatically).' }
    elseif ($needUserspace) { Write-Ok 'Tailscale present - userspace task still needed' }
    else { Write-Ok 'Tailscale userspace task already in place' }

    if (($needNode -or $needUserspace) -and -not (Test-Admin)) {
        if ($needUserspace) { Write-Host (Get-UserspaceAdminPrompt) -ForegroundColor Yellow }
        Write-Info 'Administrator rights are needed. Approve the Windows prompt; the installer continues in a new window.'
        $self = (Get-Process -Id $PID).Path
        $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), '-ElevatedChild',
            '-UserLocalAppData', ('"' + $UserLocalAppData + '"'), '-UserDesktop', ('"' + $UserDesktop + '"'))
        if ($UpdateOnly) { $argList += '-UpdateOnly' }
        try {
            $p = Start-Process -FilePath $self -Verb RunAs -ArgumentList $argList -Wait -PassThru
            $script:exitCode = $p.ExitCode
            Write-Info "Elevated installer finished (exit code $($script:exitCode))."
        } catch {
            Write-Bad 'Administrator rights were declined.'
            $script:exitCode = 1
        }
        return
    }

    try { Start-Transcript -LiteralPath $LogFile -Append | Out-Null; $script:transcript = $true } catch { }

    if ($needNode) { Install-Node }
    $nodeExe = Get-NodeExe
    Add-Result 'Node.js' 'PASS' ("v" + (Get-NodeVersion $nodeExe))

    # ---- 2. .env first (asked once, up front, so the rest can run unattended; preserved by the update step)
    Write-Step 'Configuring local .env'
    New-Item -ItemType Directory -Path $AppDir -Force | Out-Null
    $envLines = Update-EnvFile (-not $UpdateOnly)
    $token = Get-EnvValue $envLines 'JETSON_COMPANION_TOKEN'
    $port = Get-EnvPort
    Write-Ok ".env written (PORT=$port, HOST=127.0.0.1, COMPANION_MODE=real, JETSON_COMPANION_BASE_URL=$CompanionBaseUrl)"
    $keys = @()
    foreach ($k in @('GEMINI_API_KEY', 'ELEVENLABS_API_KEY')) { if (Get-EnvValue $envLines $k) { $keys += ($k -replace '_API_KEY', '') } }
    $detail = 'token set'; if ($keys.Count -gt 0) { $detail += '; keys: ' + ($keys -join ', ') } else { $detail += '; no Gemini/ElevenLabs keys' }
    if ($token) { Add-Result 'Local .env' 'PASS' $detail } else { Add-Result 'Local .env' 'FAIL' 'companion token missing' }

    # ---- 3. download console (keep .env / data)
    Write-Step "Downloading AIRVIX console (master) to $AppDir"
    Stop-AirvixServer (Get-EnvPort)
    Update-ConsoleFiles
    Write-Ok 'Console files up to date'
    Add-Result 'Console files (master)' 'PASS' $AppDir

    # ---- 4. npm ci
    Write-Step 'Installing dependencies (npm ci) - this can take a few minutes'
    try {
        Invoke-NpmCi $nodeExe
    } catch {
        $rollback = Join-Path $Root 'rollback'
        if (Test-Path -LiteralPath (Join-Path $rollback 'server.js')) {
            Write-Wrn 'npm ci failed - restoring the previous console code.'
            Copy-CodeTree $rollback $AppDir
        }
        throw
    }
    Push-Location -LiteralPath $AppDir
    try {
        $probe = (Get-NativeOutput $nodeExe @('--input-type=commonjs', '-e', "const D=require('better-sqlite3');new D(':memory:').close();console.log('native-ok')")).Trim()
    } finally { Pop-Location }
    if ($probe -eq 'native-ok') { Write-Ok 'npm ci done, native modules load'; Add-Result 'npm ci + native modules' 'PASS' 'better-sqlite3 OK' }
    else { Write-Wrn 'npm ci finished but better-sqlite3 failed to load'; Add-Result 'npm ci + native modules' 'WARN' 'better-sqlite3 did not load' }

    # ---- 5. launchers + shortcuts
    Write-Step 'Creating launchers and desktop shortcuts'
    Write-Launchers
    $icon = ''; if ($nodeExe) { $icon = "$nodeExe,0" }
    New-Shortcut (Join-Path $UserDesktop 'AIRVIX.lnk') $StartBat $Root 'Start the AIRVIX ground console' $icon
    New-Shortcut (Join-Path $UserDesktop 'AIRVIX Update.lnk') $UpdateBat $Root 'Update the AIRVIX ground console (keeps settings)' ''
    Write-Ok "Desktop shortcuts: AIRVIX, AIRVIX Update  ($UserDesktop)"
    Add-Result 'Desktop shortcuts' 'PASS' 'AIRVIX, AIRVIX Update'

    # ---- 6. Tailscale userspace (no TUN service, no hosts/DNS/NRPT edits)
    Write-Step 'Tailscale userspace'
    $ts = Get-TailscaleExe
    $script:socksReady = $false
    if (-not $ts) {
        Write-Wrn 'Tailscale is not installed - skipped. The Jetson is reachable only on the same home network.'
        Add-Result 'Tailscale' 'WARN' 'not installed (skipped on purpose)'
    } else {
        if (-not (Test-UserspaceReady $ts)) { Enable-AirvixTailscaleUserspace $ts }
        else { Write-Ok "Userspace task $TailscaleTaskName already present and the Tailscale service is Disabled" }
        Set-JetsonSocksProxyInEnv
        $script:socksReady = $true
        Add-Result 'Tailscale userspace' 'PASS' "$TailscaleTaskName SOCKS localhost:1055"
        $st = Connect-Tailscale $ts
        if ($st -and [string]$st.BackendState -eq 'Running') {
            $suffix = Get-TailnetSuffix $st
            $myIp = ''
            try { $myIp = (@($st.Self.TailscaleIPs) | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' } | Select-Object -First 1) } catch { }
            if ($suffix -and $suffix -ne $TailnetSuffix) {
                Write-Wrn "Signed in to tailnet '$suffix' but the Jetson is in '$TailnetSuffix'. Switch account in the Tailscale tray menu."
                Add-Result 'Tailscale sign-in' 'WARN' "connected to $suffix (expected $TailnetSuffix)"
            } else {
                Write-Ok "Tailscale connected ($suffix, this laptop $myIp)"
                Add-Result 'Tailscale sign-in' 'PASS' "connected ($suffix $myIp)"
            }
        } else {
            $state = ''; if ($st) { $state = [string]$st.BackendState }
            Write-Wrn 'Userspace Tailscale is up, but this laptop is not signed in yet. Use the Tailscale tray icon, then re-run the installer.'
            Add-Result 'Tailscale sign-in' 'WARN' "not signed in (state: $state)"
        }
    }

    # ---- 7. Jetson reachability
    Invoke-ReachabilityTests $token $script:socksReady
    $token = $null
    Show-Summary
    Write-UpdateStatus 'ok' ''
    if (@($Summary | Where-Object { $_.Status -eq 'FAIL' }).Count -gt 0) { $script:exitCode = 2 }
}

try {
    Invoke-Main
} catch {
    $script:exitCode = 1
    Write-Host ''
    Write-Bad ("Installer stopped: " + $_.Exception.Message)
    Write-Host "    Log: $LogFile" -ForegroundColor Yellow
    Write-UpdateStatus 'failed' $_.Exception.Message
    if ($UpdateOnly) { Start-ExistingAirvixServer }
} finally {
    if ($script:transcript) { try { Stop-Transcript | Out-Null } catch { } }
    if ($ElevatedChild) { Write-Host ''; [void](Read-Host 'Press Enter to close this window') }
}
exit $script:exitCode
