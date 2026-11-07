# The demo Cardboard started unseen, for a rehearsal or a take on the laptop while someone uses it: start-cardboard.ps1's
# environment ($AppEnv in demo-env.ps1, every CLAUDE*/ANTHROPIC* removed first) through unseen\start-unseen.ps1, which
# starts it outside the foreground app on virtual desktop 2, never activated, 1536x864 DIP (1920x1080 px at 125%), with
# the DevTools port. Muted unless -Sound (a rehearsal plays on the person's speakers; a take records the app's audio).
# Prints the launcher's lines; the last is "pid=<pid> hwnd=<hwnd>" (the window to capture: cap-run.ps1 -Hwnd).
#   powershell -ExecutionPolicy Bypass -File launch-demo.ps1 [-DebugPort 9420] [-Sound]
# Needs the VirtualDesktop PowerShell module (Install-Module VirtualDesktop -Scope CurrentUser).
# (-DebugPort, not -Port: demo-env.ps1 sets $Port, the stand-in's, and would replace it)
param([int]$DebugPort = 9420, [switch]$Sound)
. "$PSScriptRoot\demo-env.ps1"
$ef = Join-Path $Demo "demo-app.env"
$lines = foreach ($k in $AppEnv.Keys) { "$k=$($AppEnv[$k])" }
# removed for the app: every CLAUDE*/ANTHROPIC* this session has that $AppEnv doesn't set (the scheduled task starts from
# the person's saved environment, not this one, but a saved sign-in token must not reach the stand-in either)
$names = @(Get-ChildItem Env: | Where-Object { $_.Name -match '^(CLAUDE|ANTHROPIC)' } | ForEach-Object { $_.Name }) + @('ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN')
foreach ($n in ($names | Sort-Object -Unique)) { if (-not $AppEnv.Contains($n)) { $lines += "$n=" } }
Set-Content -Encoding ASCII $ef $lines
$a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "$PSScriptRoot\unseen\start-unseen.ps1", '-Exe', $Exe, '-Profile', $Demo, '-Port', $DebugPort, '-Width', 1536, '-Height', 864, '-EnvFile', $ef)
if (-not $Sound) { $a += @('-ExtraArgs', '--mute-audio') }
powershell @a
