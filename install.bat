@echo off
setlocal
rem Copies the fpvdrone package into your JC3MP dedicated server and starts it.
rem Works from inside the repo, or on its own: if the mod files are not next to
rem this file it downloads them from GitHub first.

set "SCRIPT=%~dp0tools\install.ps1"
if exist "%SCRIPT%" goto run

echo The mod files are not next to this file - downloading them from GitHub...
set "ZIPURL=https://github.com/Timspace-bot/JCMPFPV/archive/refs/heads/claude/quirky-hamilton-6re15s.zip"
set "WORK=%TEMP%\jcmpfpv"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; if (Test-Path $env:WORK) { Remove-Item -Recurse -Force $env:WORK }; New-Item -ItemType Directory -Path $env:WORK | Out-Null; $zip = Join-Path $env:WORK 'mod.zip'; Invoke-WebRequest -UseBasicParsing -Uri $env:ZIPURL -OutFile $zip; Expand-Archive -Path $zip -DestinationPath $env:WORK"
if errorlevel 1 (
    echo Download failed. Download the ZIP yourself from
    echo   %ZIPURL%
    echo extract it, and run install.bat from the extracted folder.
    goto end
)
for /d %%D in ("%WORK%\JCMPFPV-*") do set "SCRIPT=%%D\tools\install.ps1"
if not exist "%SCRIPT%" (
    echo Could not find tools\install.ps1 in the download.
    goto end
)

:run
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*

:end
pause
