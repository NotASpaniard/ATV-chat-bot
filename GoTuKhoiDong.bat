@echo off
title Go tu khoi dong AVT Chat Bot
net session >nul 2>&1
if not "%errorlevel%"=="0" (
  echo   CAN QUYEN ADMIN: chuot phai file nay -^> Run as administrator
  pause
  exit /b
)
schtasks /delete /tn "AVT ChatBot AutoStart" /f
echo.
echo Da go tu khoi dong (neu co).
pause
