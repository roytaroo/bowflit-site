@echo off
chcp 65001 >nul
cd /d "%~dp0"
title AI Society
if not exist node_modules (echo Run setup.bat first. & pause & exit /b 1)
where git >nul 2>nul && (
  echo Checking for updates...
  git pull --ff-only --quiet
  call npm install --no-fund --no-audit --silent
)
node --disable-warning=ExperimentalWarning scripts\launch.js %*
pause
