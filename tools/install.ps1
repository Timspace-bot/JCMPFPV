# Copies the fpvdrone package into your JC3MP dedicated server and starts it.
#
#   powershell -ExecutionPolicy Bypass -File tools\install.ps1
#   powershell -ExecutionPolicy Bypass -File tools\install.ps1 -ServerDir "D:\path\to\server" -NoStart
#
# Without -ServerDir it searches your Steam library for the JC3MP dedicated server.
param(
    [string]$ServerDir = "",
    [string]$SteamCommon = "B:\SteamLibrary\steamapps\common",
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repo "packages\fpvdrone"

if (-not (Test-Path (Join-Path $source "main.js"))) {
    Write-Error "Can't find $source\main.js - run this from inside the JCMPFPV repo."
}

function Find-ServerExe([string]$dir) {
    $exe = Get-ChildItem -Path $dir -Filter "*.exe" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match "server" } | Select-Object -First 1
    return $exe
}

if ($ServerDir -eq "") {
    if (-not (Test-Path $SteamCommon)) {
        Write-Error "Steam library not found at $SteamCommon. Pass -SteamCommon or -ServerDir."
    }
    Write-Host "Searching $SteamCommon for the JC3MP dedicated server..."
    $candidates = Get-ChildItem -Path $SteamCommon -Directory |
        Where-Object { $_.Name -match "Just Cause 3" -or $_.Name -match "JC3MP" }
    foreach ($c in $candidates) {
        # The server may sit directly in the folder or in a "server" subfolder.
        foreach ($d in @($c.FullName, (Join-Path $c.FullName "server"))) {
            if ((Test-Path $d) -and (Find-ServerExe $d)) { $ServerDir = $d; break }
        }
        if ($ServerDir -ne "") { break }
    }
    if ($ServerDir -eq "") {
        Write-Host ""
        Write-Host "Couldn't find the dedicated server. Folders checked:"
        $candidates | ForEach-Object { Write-Host "  $($_.FullName)" }
        Write-Host ""
        Write-Host "Install 'Just Cause 3: Multiplayer Mod - Dedicated Server' from Steam (Library > Tools),"
        Write-Host "then re-run, or pass its folder with -ServerDir."
        exit 1
    }
}

$exe = Find-ServerExe $ServerDir
Write-Host "Server folder: $ServerDir"

$packages = Join-Path $ServerDir "packages"
New-Item -ItemType Directory -Force -Path $packages | Out-Null
$dest = Join-Path $packages "fpvdrone"

# Keep an edited server config across reinstalls.
$keepConfig = $null
if (Test-Path (Join-Path $dest "config.js")) {
    $keepConfig = Get-Content -Raw (Join-Path $dest "config.js")
    Remove-Item -Recurse -Force $dest
}
Copy-Item -Recurse -Force $source $dest
if ($keepConfig -ne $null) {
    Set-Content -NoNewline -Path (Join-Path $dest "config.js") -Value $keepConfig
    Write-Host "Kept your existing config.js"
}
Write-Host "Copied package to $dest"

if ($NoStart) { exit 0 }
if (-not $exe) {
    Write-Host "Package installed, but no server .exe found in $ServerDir - start the server yourself."
    exit 0
}
Write-Host "Starting $($exe.Name)... connect from JC3MP to 127.0.0.1, then press F7 in game."
Start-Process -FilePath $exe.FullName -WorkingDirectory $ServerDir
