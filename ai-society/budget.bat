@echo off
chcp 65001 >nul
cd /d "%~dp0"
set /p YEN="1日にAIに使っていい上限 (円): "
node scripts\set-api-key.js --budget %YEN%
pause
