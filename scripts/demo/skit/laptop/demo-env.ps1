# The demo profile's paths, shared by the other scripts here. Change them to the laptop's, once.
#   . .\demo-env.ps1        (dot-sourced by make-project.ps1, start-actor.ps1, start-cardboard.ps1)
$Cardboard = "D:\cardboard\Cardboard"            # the installed build (Cardboard.exe, resources\)
$Demo      = "D:\cbwork\skit\demo"               # the demo profile: its own user data, library and Claude Code config
$Port      = 8787                                # the stand-in (actor.js) on 127.0.0.1
$Project   = "Morning Brew promo"
$Skit      = Split-Path -Parent $PSScriptRoot     # scripts\demo\skit

$UserData  = Join-Path $Demo "userdata"
$Library   = Join-Path $Demo "home"
$ClaudeCfg = Join-Path $Demo "claude-config"      # a fresh Claude Code config: the user's own sign-in is never read
# The demo Cardboard's control socket (on Windows a named pipe made from this path). cb finds the app by
# CARDBOARD_SOCKET only (CARDBOARD_USER_DATA means nothing to it): without it, cb here would reach the user's own
# Cardboard, if it runs.
$Socket    = Join-Path $UserData "cardboard.sock"
$Exe       = Join-Path $Cardboard "Cardboard.exe"
$Cli       = Join-Path $Cardboard "resources\cli\cardboard.mjs"
$Claude    = Join-Path $Cardboard "resources\director\claude.exe"   # the build's own Claude Code
foreach ($d in @($UserData, $Library, $ClaudeCfg)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

# The demo Cardboard's environment (start-cardboard.ps1), for it only. Every CLAUDE*/ANTHROPIC* variable is removed
# first (a sign-in token, or a Claude Code session's own variables when started from one), then these are set.
$AppEnv = [ordered]@{
  CARDBOARD_USER_DATA                      = $UserData
  CARDBOARD_HOME                           = $Library
  CARDBOARD_SOCKET                         = $Socket
  CARDBOARD_CLAUDE_PATH                    = $Claude
  CLAUDE_CONFIG_DIR                        = $ClaudeCfg
  ANTHROPIC_BASE_URL                       = "http://127.0.0.1:$Port"
  ANTHROPIC_API_KEY                        = "sk-mock"
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"
  DISABLE_AUTOUPDATER                      = "1"
}

# Cardboard's own cb, run by Cardboard's Node. Cardboard.exe is a Windows (GUI) program: PowerShell waits for it, and
# shows what it prints, only when its output goes down a pipe.
function cb {
  $env:ELECTRON_RUN_AS_NODE = "1"; $env:CARDBOARD_HOME = $Library; $env:CARDBOARD_SOCKET = $Socket
  & $Exe $Cli @args 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { $_ } }
  Remove-Item Env:ELECTRON_RUN_AS_NODE
}
