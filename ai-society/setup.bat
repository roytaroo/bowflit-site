@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === AI Society setup ===
where node >nul 2>nul || (echo Node.js not found. Run scripts\windows\bootstrap.ps1 first. & pause & exit /b 1)
call npm install --no-fund --no-audit || (echo npm install failed & pause & exit /b 1)
node --disable-warning=ExperimentalWarning scripts\setup.js %*
pause
