@echo off
rem Double-click to copy the fpvdrone package into your JC3MP server and start it.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install.ps1" %*
pause
