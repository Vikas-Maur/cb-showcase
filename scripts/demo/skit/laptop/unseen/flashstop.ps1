# flashstop.ps1 -Port <n> [-TestPid <pid>]: stops a test or demo Cardboard's taskbar flash (FlashWindowEx with
# FLASHW_STOP) on every visible top-level window of its main process. An API call on our own window, not input: it moves
# nothing and doesn't change the foreground. Cardboard flashes its window when a Claude Code turn ends while it isn't
# focused (the Windows port); a window on desktop 2 never is, and a flash can invite the person to switch to it.
# The process is the Cardboard.exe (no --type) whose command line carries --remote-debugging-port=<Port>, so the
# person's own Cardboard is never touched; -TestPid names it directly (still checked against the port).
param([Parameter(Mandatory)][int]$Port, [int]$TestPid = 0)
. "$PSScriptRoot\win32.ps1"
if (-not ('FlashStop' -as [type])) {
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class FlashStop {
  [StructLayout(LayoutKind.Sequential)] struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }
  [DllImport("user32.dll")] static extern bool FlashWindowEx(ref FLASHWINFO f);
  public static bool Stop(IntPtr h) { var f = new FLASHWINFO(); f.cbSize = (uint)Marshal.SizeOf(typeof(FLASHWINFO)); f.hwnd = h; f.dwFlags = 0; f.uCount = 0; f.dwTimeout = 0; return FlashWindowEx(ref f); }
}
'@
}
$p = if ($TestPid) { Get-CimInstance Win32_Process -Filter "ProcessId=$TestPid" } else { Get-CimInstance Win32_Process -Filter "Name='Cardboard.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -match "remote-debugging-port=$Port(\s|$)" } | Select-Object -First 1 }
if (-not $p -or $p.Name -ne 'Cardboard.exe' -or $p.CommandLine -notmatch "remote-debugging-port=$Port(\s|$)") { "no test Cardboard on port $Port"; return }
$n = 0; foreach ($w in [W32]::Windows([int]$p.ProcessId)) { if ([W32]::IsWindowVisible($w)) { [void][FlashStop]::Stop($w); $n++ } }
"flash stopped on $n window(s) of $($p.ProcessId)"
