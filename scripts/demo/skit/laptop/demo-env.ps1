# The demo profile's paths, shared by the other scripts here. Change them to the laptop's, once.
#   . .\demo-env.ps1        (dot-sourced by make-project.ps1, start-actor.ps1, start-cardboard.ps1)
$Cardboard = "D:\cardboard\Cardboard"            # the installed build (Cardboard.exe, resources\)
$Demo      = "D:\cbdemo"                         # the demo profile: its own user data, library and Claude Code config
$Port      = 8787                                # the stand-in (actor.js) on 127.0.0.1
$Project   = "Morning Brew promo"
$Skit      = Split-Path -Parent $PSScriptRoot     # scripts\demo\skit

$UserData  = Join-Path $Demo "userdata"
$Library   = Join-Path $Demo "home"
$ClaudeCfg = Join-Path $Demo "claude-config"      # a fresh Claude Code config: the user's own sign-in is never read
$Exe       = Join-Path $Cardboard "Cardboard.exe"
$Cli       = Join-Path $Cardboard "resources\cli\cardboard.mjs"
$Claude    = Join-Path $Cardboard "resources\director\claude.exe"   # the build's own Claude Code
foreach ($d in @($UserData, $Library, $ClaudeCfg)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

# Cardboard's own cb, run by Cardboard's Node
function cb { $env:ELECTRON_RUN_AS_NODE = "1"; $env:CARDBOARD_HOME = $Library; & $Exe $Cli @args; Remove-Item Env:ELECTRON_RUN_AS_NODE }
