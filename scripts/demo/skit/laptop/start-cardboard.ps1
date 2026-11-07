# The demo Cardboard: its own profile and library, and its Claude Code (the person's own agent, provider "claude")
# talking to the stand-in on 127.0.0.1 with a placeholder key and a fresh config folder, so the user's own sign-in is
# never read or sent. The Director is left alone (Cardboard points it at its own gateway whatever the environment says).
# Not muted by default: OBS records the voices through Application Audio Capture. -Mute for a rehearsal (--mute-audio);
# -DebugPort <n> to drive it over the DevTools protocol.
#   powershell -ExecutionPolicy Bypass -File start-cardboard.ps1 [-Mute] [-DebugPort 9420]
param([switch]$Mute, [int]$DebugPort = 0)
. "$PSScriptRoot\demo-env.ps1"
Get-ChildItem Env: | Where-Object { $_.Name -match '^(CLAUDE|ANTHROPIC)' } | ForEach-Object { Remove-Item "Env:$($_.Name)" }
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
foreach ($k in $AppEnv.Keys) { Set-Item "Env:$k" $AppEnv[$k] }
$a = @()
if ($Mute) { $a += "--mute-audio" }
if ($DebugPort) { $a += "--remote-debugging-port=$DebugPort" }
if ($a.Count) { Start-Process -FilePath $Exe -ArgumentList $a } else { Start-Process -FilePath $Exe }
