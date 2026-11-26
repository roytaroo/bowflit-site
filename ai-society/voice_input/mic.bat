@echo off
chcp 65001 >nul
title AI Society mic
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Python environment not found. Run setup.bat first.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" talk.py %*
pause
