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
    [switch]$NoStart
)

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
    if ($ServerDir -eq "") {
        Write-Host ""
        Write-Host "Couldn't find a JC3MP server executable. Folders checked:"
        foreach ($c in $candidates) {
            Write-Host "  $($c.FullName)"
            Get-ChildItem -Path $c.FullName -Filter "*.exe" -File -Recurse -Depth 2 -ErrorAction SilentlyContinue |
                Select-Object -First 15 | ForEach-Object { Write-Host "      $($_.FullName)" }
        }
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
