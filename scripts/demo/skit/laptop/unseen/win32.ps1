# win32.ps1: the Win32 calls the unseen launcher and the focus guard use (dot-sourced).
if (-not ('W32' -as [type])) {
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic;
public static class W32 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, int cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static string Title(IntPtr h) { var s = new StringBuilder(256); GetWindowText(h, s, 256); return s.ToString(); }
  public static int PidOf(IntPtr h) { int p; GetWindowThreadProcessId(h, out p); return p; }
  public static List<IntPtr> Windows(int pid) {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => { int p; GetWindowThreadProcessId(h, out p); if (p == pid && GetWindow(h, 4) == IntPtr.Zero) { var c = new StringBuilder(64); GetClassName(h, c, 64); if (c.ToString() == "Chrome_WidgetWin_1") list.Add(h); } return true; }, IntPtr.Zero);
    return list;
  }
  public static string Watch(int pid, int ms, out IntPtr shown) {
    shown = IntPtr.Zero; var seen = new HashSet<IntPtr>(); var log = new StringBuilder(); var t0 = DateTime.Now;
    while ((DateTime.Now - t0).TotalMilliseconds < ms) {
      foreach (var h in Windows(pid)) {
        if (seen.Add(h)) { RECT r; GetWindowRect(h, out r); log.AppendFormat("[{0} ms] new window {1}: visible {2}, minimized {3}, at ({4},{5}) {6}x{7}; parked off-screen\n", (int)(DateTime.Now - t0).TotalMilliseconds, h, IsWindowVisible(h), IsIconic(h), r.L, r.T, r.R - r.L, r.B - r.T); SetWindowPos(h, IntPtr.Zero, -32000, -32000, 0, 0, 0x0001 | 0x0004 | 0x0010); }
        if (IsWindowVisible(h) && Title(h).Length > 0) { RECT r; GetWindowRect(h, out r); log.AppendFormat("[{0} ms] shown: {1} '{2}', minimized {3}, at ({4},{5})\n", (int)(DateTime.Now - t0).TotalMilliseconds, h, Title(h), IsIconic(h), r.L, r.T); shown = h; return log.ToString(); }
      }
      System.Threading.Thread.Sleep(1);
    }
    return log.ToString() + "timed out\n";
  }
}
'@
}
