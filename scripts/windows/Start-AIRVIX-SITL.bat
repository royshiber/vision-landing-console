@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-AIRVIX-SITL.ps1" %*
set ERR=%ERRORLEVEL%
if not "%ERR%"=="0" (
  echo.
  echo ההפעלה נכשלה. קראו את ההודעה למעלה.
  pause
  exit /b %ERR%
)
echo.
pause
exit /b 0
