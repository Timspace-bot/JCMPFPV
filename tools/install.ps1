# Copies the fpvdrone package into your JC3MP dedicated server and starts it.
#
#   powershell -ExecutionPolicy Bypass -File tools\install.ps1
#   powershell -ExecutionPolicy Bypass -File tools\install.ps1 -ServerDir "D:\path\to\server" -NoStart
#
# Without -ServerDir it searches every Steam library on the PC (from Steam's
# libraryfolders.vdf plus X:\SteamLibrary on each drive) for the JC3MP server.
param(
    [string]$ServerDir = "",
    [string]$SteamCommon = "",
    [string]$InstallServerTo = "",   # where to put the server if it has to be downloaded
    [switch]$Yes,                    # don't ask before downloading the server
    [switch]$NoStart
)

$SERVER_APPID = 619960   # Just Cause 3: Multiplayer Mod - Dedicated Server (anonymous SteamCMD login)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repo "packages\fpvdrone"

if (-not (Test-Path (Join-Path $source "main.js"))) {
    Write-Error "Can't find $source\main.js - run this from inside the JCMPFPV repo."
}

# Server executables, best match first: Server.exe, then anything with "server"
# in the name (but not Steam's own helpers).
function Find-ServerExes([string]$dir, [int]$depth) {
    $all = Get-ChildItem -Path $dir -Filter "*.exe" -File -Recurse -Depth $depth -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match "server" -and $_.Name -notmatch "steam|crash|report" }
    return @($all | Sort-Object @{ Expression = { if ($_.Name -ieq "Server.exe") { 0 } else { 1 } } }, @{ Expression = { $_.FullName.Length } })
}

function Find-ServerExe([string]$dir) {
    return (Find-ServerExes $dir 0 | Select-Object -First 1)
}

function Get-SteamCommonDirs {
    $libs = New-Object System.Collections.Generic.List[string]
    if ($SteamCommon -ne "") { $libs.Add((Split-Path -Parent (Split-Path -Parent $SteamCommon))) }
    foreach ($key in @("HKCU:\Software\Valve\Steam", "HKLM:\SOFTWARE\WOW6432Node\Valve\Steam")) {
        $props = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
        foreach ($root in @($props.SteamPath, $props.InstallPath)) {
            if (-not $root) { continue }
            $root = $root -replace "/", "\"
            $libs.Add($root)
            $vdf = Join-Path $root "steamapps\libraryfolders.vdf"
            if (Test-Path $vdf) {
                foreach ($m in [regex]::Matches((Get-Content -Raw $vdf), '"path"\s+"([^"]+)"')) {
                    $libs.Add(($m.Groups[1].Value -replace "\\\\", "\"))
                }
            }
        }
    }
    foreach ($drive in (Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue)) {
        foreach ($sub in @("SteamLibrary", "Steam", "Program Files (x86)\Steam", "Program Files\Steam")) {
            $libs.Add((Join-Path $drive.Root $sub))
        }
    }
    $seen = @{}
    foreach ($lib in $libs) {
        $common = Join-Path $lib "steamapps\common"
        $k = $common.ToLowerInvariant()
        if ($seen.ContainsKey($k) -or -not (Test-Path $common)) { continue }
        $seen[$k] = $true
        $common
    }
}

# Download SteamCMD and use it to install/update the dedicated server.
function Install-Server([string]$dir) {
    $steamcmdDir = Join-Path $dir "steamcmd"
    $steamcmd = Join-Path $steamcmdDir "steamcmd.exe"
    New-Item -ItemType Directory -Force -Path $steamcmdDir | Out-Null
    if (-not (Test-Path $steamcmd)) {
        Write-Host "Downloading SteamCMD..."
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $zip = Join-Path $steamcmdDir "steamcmd.zip"
        Invoke-WebRequest -UseBasicParsing -Uri "https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip" -OutFile $zip
        Expand-Archive -Force -Path $zip -DestinationPath $steamcmdDir
        Remove-Item $zip
    }
    # SteamCMD updates itself on first run and sometimes exits before
    # installing anything, so try twice and check for the server exe.
    for ($i = 1; $i -le 2; $i++) {
        Write-Host "Installing the JC3MP server with SteamCMD (attempt $i)... this can take a few minutes."
        & $steamcmd +force_install_dir "$dir" +login anonymous +app_update $SERVER_APPID validate +quit | Out-Host
        if (Find-ServerExe $dir) { return $dir }
    }
    Write-Error "SteamCMD finished but no server executable appeared in $dir. Check the SteamCMD output above."
}

if ($ServerDir -eq "") {
    Write-Host "Searching your Steam libraries for the JC3MP dedicated server..."
    $candidates = @()
    foreach ($common in Get-SteamCommonDirs) {
        Write-Host "  library: $common"
        $candidates += @(Get-ChildItem -Path $common -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match "Just Cause 3" -or $_.Name -match "JC3MP" })
    }
    # Dedicated-server folders first, then the multiplayer mod, then the game.
    $candidates = $candidates | Sort-Object @{ Expression = {
        if ($_.Name -match "Server") { 0 } elseif ($_.Name -match "Multiplayer|JC3MP") { 1 } else { 2 } } }
    foreach ($c in $candidates) {
        $exe = Find-ServerExes $c.FullName 3 | Select-Object -First 1
        if ($exe) { $ServerDir = $exe.DirectoryName; break }
    }
    # A server this script installed earlier.
    if ($ServerDir -eq "") {
        foreach ($drive in (Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue)) {
            $d = Join-Path $drive.Root "JC3MP-Server"
            if ((Test-Path $d) -and (Find-ServerExe $d)) { $ServerDir = $d; break }
        }
    }
    if ($ServerDir -eq "") {
        Write-Host ""
        Write-Host "No JC3MP dedicated server is installed (only the game / client were found)."
        if ($InstallServerTo -eq "") {
            # Put it next to the JC3MP client if we saw it, else on the first library's drive.
            $mp = $candidates | Where-Object { $_.Name -match "Multiplayer|JC3MP" } | Select-Object -First 1
            $base = if ($mp) { Split-Path -Qualifier $mp.FullName } else { "C:" }
            $InstallServerTo = Join-Path ($base + "\") "JC3MP-Server"
        }
        if (-not $Yes) {
            $answer = Read-Host "Download the free JC3MP dedicated server (~1 GB, Steam app $SERVER_APPID) to $InstallServerTo now? [Y/n]"
            if ($answer -match "^[nN]") {
                Write-Host "OK - install it yourself, then re-run with -ServerDir <folder>."
                exit 1
            }
        }
        $ServerDir = Install-Server $InstallServerTo
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
