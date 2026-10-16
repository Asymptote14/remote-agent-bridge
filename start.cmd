@echo off
cd /d "%~dp0"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\rab.ps1" start
if errorlevel 1 goto :error
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\rab.ps1" open
pause
exit /b 0
:error
echo Remote Agent Bridge start failed.
pause
exit /b 1
