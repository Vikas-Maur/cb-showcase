# start-unseen.ps1 -Exe <Cardboard.exe> -Profile <dir> -Port <n> [-Width <dip> -Height <dip>] [-ExtraArgs "<switches>"]
#   [-EnvFile <file>] [-CartonOff] [-Switches] [-WaitForActive]
# Starts a test or demo Cardboard on this laptop without taking the person's screen (the laptop's launcher, used by
# ..\launch-demo.ps1):
# - its own profile: CARDBOARD_USER_DATA / CARDBOARD_HOME / CARDBOARD_SOCKET under -Profile; -EnvFile adds more of its
#   environment, one NAME=VALUE a line (NAME= removes it), set after those;
# - started OUTSIDE the foreground app's process tree: a one-off Task Scheduler task (interactive, this user) runs a
#   wscript .vbs (no console anywhere) that sets that environment and starts Cardboard minimized without activation
#   (window style 7), so Windows' foreground lock refuses the app's own activation;
# - a 1 ms watcher parks each new top-level window of the app off-screen before it is shown; once shown it is moved to
#   virtual desktop 2 (the VirtualDesktop PowerShell module), put on-screen there (-Width x -Height in DIP, or as
#   Cardboard sized it) and never activated; a window that doesn't come within 240 s: the app is closed by its pid;
# - --remote-debugging-port=<Port> to drive it over DevTools; -ExtraArgs adds switches (--mute-audio for a rehearsal);
# - -CurrentDesktop: the window goes to the desktop on screen instead of desktop 2 (still never activated): OBS's Window
#   Capture records a window on another virtual desktop as black (Windows hides it there), so a take OBS records needs it;
# - -WaitForActive: wait while the person's last input is 150 s old or more (no longer the default: the user allowed
#   launches while they are away, 2026-11-07). No input is ever sent to the session.
# Prints "pid=<main pid> hwnd=<hwnd>" last.
param([Parameter(Mandatory)][string]$Exe, [Parameter(Mandatory)][string]$Profile, [Parameter(Mandatory)][int]$Port,
  [switch]$Switches, [int]$Width = 0, [int]$Height = 0, [string]$ExtraArgs = '', [switch]$CartonOff, [string]$EnvFile = '', [switch]$WaitForActive, [switch]$CurrentDesktop)
$ErrorActionPreference = 'Stop'
Import-Module VirtualDesktop -WarningAction SilentlyContinue
. "$PSScriptRoot\win32.ps1"

if (-not ('IdleOnly' -as [type])) { Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class IdleOnly { [StructLayout(LayoutKind.Sequential)] struct LII { public uint cb, t; } [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LII l); public static uint Ms() { var l = new LII(); l.cb = 8; GetLastInputInfo(ref l); return (uint)Environment.TickCount - l.t; } }' }
# Launch only while the user's last input is under 150 s old, so Windows' foreground lock (200 s) still holds and the new
# window can't take the foreground (2026-11-05: one did, at user idle 1036 s). Idle longer: wait, checking every 30 s.
# No synthetic input is ever sent to get around it (the orchestrator's rule, until the user says otherwise).
# 2026-11-07: the user lifted this rule ("yes even when im away"): the wait runs only with -WaitForActive.
while ($WaitForActive -and [IdleOnly]::Ms() -ge 150000) { "$((Get-Date).ToString('HH:mm:ss')) user idle $([int]([IdleOnly]::Ms() / 1000)) s: waiting until they are active (checked every 30 s)"; Start-Sleep -Seconds 30 }
if ((Get-DesktopCount) -lt 2) { $null = New-Desktop; "made virtual desktop 2" }
$cur = Get-DesktopIndex (Get-CurrentDesktop); $ti = if ($CurrentDesktop) { $cur } elseif ($cur -eq 0) { 1 } else { 0 }; $d2 = Get-Desktop $ti; "user's desktop index: $cur (never switched); test desktop index: $ti"
# (no focus guard and no watch on the user's foreground: the user may look at, focus or click a test window at any time; 2026-11-06)
$cargs = "--remote-debugging-port=$Port"
if ($ExtraArgs) { $cargs += " $ExtraArgs" }
if ($Switches) { $cargs += " --disable-features=CalculateNativeWinOcclusion --disable-renderer-backgrounding --disable-background-timer-throttling --disable-backgrounding-occluded-windows" }
New-Item -ItemType Directory -Force "$Profile\userdata", "$Profile\home" | Out-Null
$tag = (Split-Path $Profile -Leaf); $vbs = Join-Path $env:TEMP "cardboard-launch-$tag.vbs"
# No console anywhere in the chain (a cmd's window came to the front and gave its child, Cardboard, the right to take
# the foreground): wscript runs this script with no window; it sets the test profile's environment and starts
# Cardboard with window style 7 (SW_SHOWMINNOACTIVE).
@"
On Error Resume Next
Set sh = CreateObject("WScript.Shell")
Set env = sh.Environment("Process")
env("CARDBOARD_USER_DATA") = "$Profile\userdata"
env("CARDBOARD_HOME") = "$Profile\home"
env("CARDBOARD_SOCKET") = "$Profile\userdata\cardboard.sock"
$(if ($CartonOff) { 'env("CARDBOARD_CARTON") = "0"' } else { 'env.Remove "CARDBOARD_CARTON"' })
env.Remove "ELECTRON_RUN_AS_NODE"
$(if ($EnvFile) { (Get-Content $EnvFile | Where-Object { $_ -match '^\w+=' } | ForEach-Object { $k, $v = $_ -split '=', 2; if ($v -eq '') { "env.Remove ""$k""" } else { "env(""$k"") = ""$($v.Replace([string][char]34, [string][char]34 * 2))""" } }) -join "`n" })
sh.Run """$Exe"" $cargs", 4, False
"@ | Set-Content -Encoding ASCII $vbs
$task = "CardboardTest_$tag"
schtasks /create /tn $task /tr "wscript.exe //B //Nologo `"$vbs`"" /sc once /st 23:59 /f /it | Out-Null
# schtasks makes a task "start only on AC power": on battery it stays Queued and the app never starts (2026-11-06). Allow
# it on battery (and don't stop it when the power goes).
$st = Get-ScheduledTask -TaskName $task; $st.Settings.DisallowStartIfOnBatteries = $false; $st.Settings.StopIfGoingOnBatteries = $false; $null = Set-ScheduledTask -InputObject $st
"args: $cargs"
$t0 = Get-Date; $runOut = (schtasks /run /tn $task 2>&1 | Out-String).Trim(); "schtasks /run: $runOut"
# the main process: the Cardboard.exe without --type whose renderer children carry this profile's --user-data-dir
$main = $null
for ($i = 0; $i -lt 300 -and -not $main; $i++) {
  $kid = Get-CimInstance Win32_Process -Filter "Name='Cardboard.exe'" | Where-Object { $_.CommandLine -match [regex]::Escape("$Profile\userdata") } | Select-Object -First 1
  if ($kid) { $main = Get-CimInstance Win32_Process -Filter "ProcessId=$($kid.ParentProcessId)" | Where-Object { $_.Name -eq 'Cardboard.exe' } }
  if (-not $main) { $c = Get-CimInstance Win32_Process -Filter "Name='Cardboard.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -match "remote-debugging-port=$Port" } | Select-Object -First 1; if ($c) { $main = $c } }
  if (-not $main) { Start-Sleep -Milliseconds 20 }
}
if (-not $main) { "task state: " + ((schtasks /query /tn $task /v /fo list 2>&1 | Select-String 'Status:|Last Run Time:|Last Result:' | ForEach-Object { $_.Line.Trim() }) -join ' | ') }
schtasks /delete /tn $task /f | Out-Null
Remove-Item -LiteralPath $vbs -ErrorAction SilentlyContinue
if (-not $main) { throw "the test Cardboard didn't start" }
$pid_ = [int]$main.ProcessId; "main pid $pid_ (parent $($main.ParentProcessId)), found after $([int]((Get-Date) - $t0).TotalMilliseconds) ms"
# 4 minutes: a freshly built app's first start can take over a minute before its code runs (2026-11-05: the baseline
# build took 61 s, its window came after a 60 s watch had ended, and so showed unparked on the user's desktop)
$h = [IntPtr]::Zero; $log = [W32]::Watch($pid_, 240000, [ref]$h); $log.TrimEnd()
# no window in time: close what was started (by its pid, its port checked) so a late window can never show unparked
if ($h -eq [IntPtr]::Zero) { $c = Get-CimInstance Win32_Process -Filter "ProcessId=$pid_"; if ($c -and $c.CommandLine -match "remote-debugging-port=$Port") { taskkill /PID $pid_ /T /F | Out-Null }; throw "no window shown within 240 s: closed pid $pid_" }
Move-Window -Desktop $d2 -Hwnd $h | Out-Null
"moved to desktop index $(Get-DesktopIndex (Get-DesktopFromWindow $h)); user's desktop still index $(Get-DesktopIndex (Get-CurrentDesktop))"
$r = New-Object W32+RECT; [W32]::GetWindowRect($h, [ref]$r) | Out-Null
$w = if ($Width) { $Width } else { 0 }; $hh = if ($Height) { $Height } else { 0 }
if ($w) { [W32]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, $w, $hh, 0x0004 -bor 0x0010) | Out-Null } else { [W32]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 0x0001 -bor 0x0004 -bor 0x0010) | Out-Null }
if ([W32]::IsIconic($h)) { "still minimized: not restoring it (a restore on another desktop switches the view to it)" }
Start-Sleep -Milliseconds 600
[W32]::GetWindowRect($h, [ref]$r) | Out-Null
"on desktop 2: visible $([W32]::IsWindowVisible($h)), minimized $([W32]::IsIconic($h)), at ($($r.L),$($r.T)) $($r.R-$r.L)x$($r.B-$r.T)"
"pid=$pid_ hwnd=$h"





