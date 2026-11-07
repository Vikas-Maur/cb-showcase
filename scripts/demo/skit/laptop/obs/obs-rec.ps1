# obs-rec.ps1 -Start | -Stop: the take's recording with the user's OBS (E:\OBS\obs-studio, 32.1.2) on OUR config only:
# --portable reads E:\OBS\obs-studio\config\obs-studio (make-config.ps1: profile/collection "CardboardDemo", scene
# "Cardboard" = Window Capture (WGC) + Application Audio Capture of Cardboard.exe, NVENC HQ, hybrid MP4 into D:\OBS);
# the user's %APPDATA%\obs-studio is never read or written.
# -Start: refuses if any OBS runs; clears our config's crash marker; starts OBS minimized (not --minimize-to-tray: on close
#   that crashed in the hidden preview's teardown) recording at once; waits for the new D:\OBS\skit-*.mp4; writes
#   %TEMP%\cardboard-obs-rec.json {pid, file, started}.
# -Stop: closes that OBS gracefully (WM_CLOSE: ConfirmOnExit=false in our config, so it stops the recording, finalizes
#   the file and exits); after 60 s without exit, kills that pid (the hybrid MP4 stays playable). -Name renames the file.
param([switch]$Start, [switch]$Stop, [string]$Name = '')
$OBS = 'E:\OBS\obs-studio\bin\64bit\obs64.exe'; $CFG = 'E:\OBS\obs-studio\config\obs-studio'; $state = Join-Path $env:TEMP 'cardboard-obs-rec.json'
if ($Start) {
  if (Get-Process obs64 -ErrorAction SilentlyContinue) { throw "an OBS is already running: not touching it" }
  $before = @(Get-ChildItem D:\OBS -Filter 'skit-*' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
  Remove-Item -Recurse -Force "$CFG\.sentinel" -ErrorAction SilentlyContinue
  $t0 = Get-Date
  $obs = Start-Process -FilePath $OBS -WorkingDirectory (Split-Path $OBS) -WindowStyle Minimized -PassThru -ArgumentList '--portable', '--disable-updater', '--collection', 'CardboardDemo', '--profile', 'CardboardDemo', '--scene', 'Cardboard', '--startrecording'
  $file = $null; for ($i = 0; $i -lt 240 -and -not $file; $i++) { Start-Sleep -Milliseconds 250; $file = Get-ChildItem D:\OBS -Filter 'skit-*' -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.FullName } | Select-Object -First 1 }
  if (-not $file) { throw "OBS (pid $($obs.Id)) wrote no file in 60 s" }
  @{ pid = $obs.Id; file = $file.FullName; started = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -Encoding ASCII $state
  "$((Get-Date).ToString('HH:mm:ss.fff')) recording: OBS pid $($obs.Id) -> $($file.FullName) ($([int]((Get-Date) - $t0).TotalMilliseconds) ms after start)"
}
if ($Stop) {
  $s = Get-Content $state | ConvertFrom-Json; $p = Get-Process -Id $s.pid -ErrorAction SilentlyContinue
  if (-not $p -or $p.ProcessName -ne 'obs64') { "OBS $($s.pid) isn't running" } else {
    $tq = Get-Date; taskkill /PID $s.pid | Out-Null
    if ($p.WaitForExit(60000)) { "$((Get-Date).ToString('HH:mm:ss.fff')) OBS closed (exit $($p.ExitCode)) $([int]((Get-Date) - $tq).TotalMilliseconds) ms after WM_CLOSE" }
    else { taskkill /PID $s.pid /F | Out-Null; "OBS didn't close in 60 s: killed pid $($s.pid)" }
  }
  $f = $s.file
  if ($Name) { $dest = Join-Path (Split-Path $f) $Name; if (Test-Path $dest) { throw "$dest exists" }; Move-Item $f $dest; $f = $dest }
  $fp = 'D:\cardboard\Cardboard\resources\bin\ffprobe.exe'
  "file $f $((Get-Item $f).Length) bytes; " + ((& $fp -v error -show_entries stream=codec_type,codec_name,width,height,avg_frame_rate:format=duration -of compact $f) -join ' | ')
}
