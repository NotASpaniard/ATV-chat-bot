@echo off
title Cai tu khoi dong AVT Chat Bot
cd /d "%~dp0"
REM Can quyen Admin
net session >nul 2>&1
if not "%errorlevel%"=="0" (
  echo.
  echo   ================================================
  echo    CAN QUYEN ADMIN
  echo    Chuot phai file CaiTuKhoiDong.bat
  echo    roi chon "Run as administrator"
  echo   ================================================
  echo.
  pause
  exit /b
)
REM Tao task chay luc khoi dong may, duoi SYSTEM, tro toi start.ps1 NGAY TAI THU MUC NAY
schtasks /create /tn "AVT ChatBot AutoStart" /tr "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"%~dp0start.ps1\" auto" /sc onstart /ru SYSTEM /rl HIGHEST /f
echo.
if "%errorlevel%"=="0" (
  echo ============================================================
  echo  THANH CONG! Chatbot se TU CHAY khi may khoi dong.
  echo  Duong dan da dang ky: %~dp0start.ps1
  echo  Kiem chung: khoi dong lai may, doi ~1 phut, mo http://localhost:3007
  echo ============================================================
) else (
  echo LOI khi tao task - doc thong bao ben tren.
)
echo.
pause
