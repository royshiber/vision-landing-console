@echo off
setlocal
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies...
  npm install
)

:: Try PM2 first (auto-restart on crash), fall back to plain node
:: Why: `pm2 start` when the app already exists does not reload JS from disk — code updates look like "404 on advisor".
:: What: restart if already registered so the latest server.js (and routes) always load.
where pm2 >nul 2>&1
if %ERRORLEVEL% == 0 (
  echo Starting with PM2 (auto-restart enabled)...
  pm2 describe vision-landing-console >nul 2>&1
  if %ERRORLEVEL% == 0 (
    echo Reloading server to pick up latest code...
    pm2 restart vision-landing-console --update-env
  ) else (
    pm2 start ecosystem.config.cjs
  )
  pm2 logs vision-landing-console
) else (
  echo PM2 not found - starting directly. Install globally with: npm install -g pm2
  start "" http://localhost:4010
  npm run start
)
