# Presses keys in a Cardboard window with real OS keyboard input (SendInput), the closest thing to a
# person typing. Brings the window of process -Id to the front, checks before every key that it still
# is (and stops if not), and gives the foreground back to the previous window at the end.
#   powershell -File sendkeys.ps1 -Id 1234 -Keys "ctrl+t ctrl+2 enter"
#   powershell -File sendkeys.ps1 -Id 1234 -Serve      one combo per line on stdin, answers ok/err per line
param([Parameter(Mandatory)][int]$Id, [string[]]$Keys = @(), [int]$DelayMs = 250, [switch]$Serve)
Add-Type @"
using System; using System.Runtime.InteropServices;
public class KB {
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit, Size = 40)] public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit, Size = 40)] public struct MINPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mi; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] i, int size);
  [DllImport("user32.dll", EntryPoint = "SendInput")] public static extern uint SendMouse(uint n, MINPUT[] i, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
  // A zero-distance mouse move: input that changes nothing, after which Windows lets us set the foreground.
  public static void Nudge() { var i = new MINPUT[1]; i[0].type = 0; i[0].mi.dwFlags = 1; SendMouse(1, i, Marshal.SizeOf(typeof(MINPUT))); }
  public static void Key(ushort vk, bool up) {
    var i = new INPUT[1];
    i[0].type = 1; i[0].ki.wVk = vk; i[0].ki.wScan = (ushort)MapVirtualKey(vk, 0);
    uint f = up ? 2u : 0u;
    // Arrows, Home/End, Delete and the right-hand modifiers are extended keys.
    if ((vk >= 0x21 && vk <= 0x2E) || vk == 0xA3 || vk == 0xA5) f |= 1u;
    i[0].ki.dwFlags = f;
    SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@
$vk = @{ ctrl = 0x11; shift = 0x10; alt = 0x12; win = 0x5B; enter = 0x0D; esc = 0x1B; escape = 0x1B; tab = 0x09; space = 0x20
  backspace = 0x08; delete = 0x2E; left = 0x25; up = 0x26; right = 0x27; down = 0x28; home = 0x24; end = 0x23
  f10 = 0x79; f11 = 0x7A; "=" = 0xBB; "-" = 0xBD; "," = 0xBC; "/" = 0xBF; "[" = 0xDB; "]" = 0xDD; "\" = 0xDC; "``" = 0xC0 }
function Code([string]$k) {
  if ($vk.ContainsKey($k)) { return [uint16]$vk[$k] }
  if ($k -match '^[a-z0-9]$') { return [uint16][char]$k.ToUpper() }
  throw "unknown key $k"
}
function Foreground { $fp = 0; [KB]::GetWindowThreadProcessId([KB]::GetForegroundWindow(), [ref]$fp) | Out-Null; return $fp }
function Press([string]$combo) {
  $fp = Foreground
  # Windows sometimes hands the foreground to the desktop or taskbar (Explorer). Take it back from
  # there, and only from there: any other window means someone is using the machine.
  if ($fp -ne $Id -and ($fp -eq 0 -or (Get-Process -Id $fp -ErrorAction SilentlyContinue).ProcessName -eq "explorer")) {
    [KB]::Nudge(); [KB]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 300; $fp = Foreground
  }
  if ($fp -ne $Id) { throw "foreground is process $fp, not $Id; stopped before '$combo'" }
  $codes = @($combo.ToLower() -split '\+(?!$)' | ForEach-Object { Code $_ })
  foreach ($c in $codes) { [KB]::Key($c, $false); Start-Sleep -Milliseconds 15 }
  [array]::Reverse($codes)
  foreach ($c in $codes) { [KB]::Key($c, $true); Start-Sleep -Milliseconds 15 }
}
$h = (Get-Process -Id $Id -ErrorAction Stop).MainWindowHandle
if ($h -eq [IntPtr]::Zero) { throw "process $Id has no window" }
$before = [KB]::GetForegroundWindow()
# Windows only lets a process take the foreground right after it sent input. Not a key: a lone Alt tap
# would open Cardboard's menu. Restore only a minimized window; SW_RESTORE would un-maximize one.
[KB]::Nudge()
if ([KB]::IsIconic($h)) { [KB]::ShowWindow($h, 9) | Out-Null }
[KB]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 400
try {
  if ($Serve) {
    [Console]::Out.WriteLine("ready"); [Console]::Out.Flush()
    while ($null -ne ($line = [Console]::In.ReadLine())) {
      try { Press $line.Trim(); $r = "ok" } catch { $r = "err $_" }
      [Console]::Out.WriteLine($r); [Console]::Out.Flush()
    }
  } else {
    # -File passes one string; combos are separated by spaces ("space" is the space bar).
    foreach ($combo in ($Keys | ForEach-Object { $_ -split '\s+' } | Where-Object { $_ })) {
      Press $combo
      "pressed $combo"
      Start-Sleep -Milliseconds $DelayMs
    }
  }
} finally {
  if ($before -ne [IntPtr]::Zero -and $before -ne $h) { [KB]::SetForegroundWindow($before) | Out-Null }
}
