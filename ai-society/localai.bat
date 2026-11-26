@echo off
chcp 65001 >nul
cd /d "%~dp0"
node scripts\set-api-key.js --local
pause
