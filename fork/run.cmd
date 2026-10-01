@echo off
rem Launch the fork from source on Windows. macOS and Linux: ./fork/run.sh
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*
exit /b %ERRORLEVEL%
