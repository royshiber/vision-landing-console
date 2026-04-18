@echo off
setlocal
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies...
  npm install
)

:: Try PM2 first (auto-restart on crash), fall back to plain node
where pm2 >nul 2>&1
if %ERRORLEVEL% == 0 (
  echo Starting with PM2 (auto-restart enabled)...
  pm2 start ecosystem.config.cjs
  pm2 logs vision-landing-console
) else (
  echo PM2 not found - starting directly. Install globally with: npm install -g pm2
  start "" http://localhost:4010
  npm run start
)
