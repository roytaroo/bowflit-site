@echo off
chcp 65001 >nul
cd /d "%~dp0"
title AI Society
if not exist node_modules (echo Run setup.bat first. & pause & exit /b 1)
where git >nul 2>nul && (
  echo Checking for updates...
  for /f %%i in ('git rev-parse HEAD') do set OLDREV=%%i
  git pull --ff-only --quiet
  rem run npm install only when package.json changed (it is slow)
  call :maybe_install
)
rem ask for the Gemini key once (skipped if already set or declined)
node scripts\set-gemini-key.js --ask
node --disable-warning=ExperimentalWarning scripts\launch.js %*
pause
exit /b

:maybe_install
git diff --quiet %OLDREV% HEAD -- package.json package-lock.json
if errorlevel 1 (
  echo Installing updated packages...
  call npm install --no-fund --no-audit --silent
)
exit /b
