@echo off
title AVT Chat Bot
cd /d "%~dp0"
REM Bam dup file nay de bat AVT Chat Bot (Ollama + Postgres + web) va mo trinh duyet.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
echo.
echo (Web da dung hoac gap loi.) Nhan phim bat ky de dong cua so...
pause >nul
