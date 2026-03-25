@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  npm install
)
start "" http://localhost:4010
npm run start
