@echo off
rem ============================================================
rem  AIRVIX ground console - one-click Windows installer
rem  Double-click this file. It runs install-airvix.ps1 with
rem  -ExecutionPolicy Bypass. Admin rights (UAC) are requested
rem  automatically only when Node.js / Tailscale must be installed.
rem  No secrets are stored in this file.
rem ============================================================
chcp 65001 >nul
setlocal EnableExtensions
title AIRVIX installer
cd /d "%~dp0"

if exist "%~dp0install-airvix.ps1" goto :run
echo [FAIL] install-airvix.ps1 was not found next to this file.
echo        Extract the WHOLE zip to a folder first, then double-click Install-AIRVIX.bat again.
pause
exit /b 1

:run
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-airvix.ps1" %*
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" echo Installer finished.
if not "%RC%"=="0" echo Installer finished with warnings or errors - code %RC%. See the summary above.
pause
exit /b %RC%
