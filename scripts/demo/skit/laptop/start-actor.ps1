# Claude 1's model for the take: the stand-in (scripts\demo\actor\actor.js) on 127.0.0.1, run by Cardboard's own Node,
# on the scene claude1-scene.json. Its waits run Cardboard's cb on the demo library. A new take: stop it (Ctrl+C) and
# start it again (its place in the scene is per run).
#   powershell -ExecutionPolicy Bypass -File start-actor.ps1
. "$PSScriptRoot\demo-env.ps1"
$env:ELECTRON_RUN_AS_NODE = "1"
$env:CARDBOARD_HOME = $Library
$env:CARDBOARD_SOCKET = $Socket
$env:ACTOR_CB = ConvertTo-Json -Compress @($Exe, $Cli)
$actor = Join-Path (Split-Path -Parent $Skit) "actor\actor.js"
$log = Join-Path $Demo ("actor-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")
Write-Host "stand-in on http://127.0.0.1:$Port  log: $log   (the human leaves: Invoke-WebRequest http://127.0.0.1:$Port/cue/gone)"
# (piped: PowerShell waits for a Windows program, and shows its lines, only then; Ctrl+C stops it)
& $Exe $actor --scene (Join-Path $Skit "claude1-scene.json") --port $Port --log $log 2>&1 | ForEach-Object { "$_" }
