# Records the demo window only, for a rehearsal (the take itself is OBS's):
#   powershell -ExecutionPolicy Bypass -File cap-run.ps1 -Hwnd <window> -Out <file.mkv> [-StopFile <file>] [-Ffmpeg <exe>]
# The window (launch-demo.ps1 prints its hwnd) through Windows Graphics Capture (ffmpeg's gfxcapture: never a monitor or
# the desktop, and it works on desktop 2), mapped to Quick Sync on the GPU that drives the screen (no copy) and encoded
# there as H.264 into Matroska (still playable if ffmpeg never finishes). Variable frame rate: a frame only when the
# window changes, so a still window records nothing (the player holds the last frame).
# Runs until the stop file appears (go.js writes <run>\cap.stop at the end; default: cap.stop beside -Out), then sends
# "q" and allows ffmpeg 5 minutes to finish: it reads the "q" at its next frame, which needs a repaint. Prints ffmpeg's
# lines (its stats every 5 s). Needs an ffmpeg with gfxcapture and QSV (8.x).
param([Parameter(Mandatory)][long]$Hwnd, [Parameter(Mandatory)][string]$Out, [string]$StopFile = '', [string]$Ffmpeg = 'E:\ffmpeg\bin\ffmpeg.exe')
if (-not $StopFile) { $StopFile = Join-Path (Split-Path -Parent $Out) 'cap.stop' }
Remove-Item -LiteralPath $StopFile -ErrorAction SilentlyContinue
$psi = New-Object System.Diagnostics.ProcessStartInfo $Ffmpeg
$psi.Arguments = "-hide_banner -y -stats_period 5 -filter_complex `"gfxcapture=hwnd=$($Hwnd):capture_cursor=0:max_framerate=60,hwmap=derive_device=qsv,format=qsv`" -c:v h264_qsv -preset medium -global_quality 23 -fps_mode passthrough `"$Out`""
$psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true; $psi.CreateNoWindow = $true
$p = [Diagnostics.Process]::Start($psi)
"$((Get-Date).ToString('HH:mm:ss.fff')) ffmpeg pid $($p.Id) started (stop file: $StopFile): $($psi.Arguments)"
while (-not (Test-Path $StopFile) -and -not $p.HasExited) { Start-Sleep -Milliseconds 250 }
if (-not $p.HasExited) {
  $tq = Get-Date; "$($tq.ToString('HH:mm:ss.fff')) stop asked: sending q"
  $p.StandardInput.Write('q'); $p.StandardInput.Flush()
  if ($p.WaitForExit(300000)) { "$((Get-Date).ToString('HH:mm:ss.fff')) ffmpeg exited $($p.ExitCode) after $([int]((Get-Date) - $tq).TotalMilliseconds) ms" }
  else { "ffmpeg still running 5 min after q: left running (pid $($p.Id))" }
} else { "$((Get-Date).ToString('HH:mm:ss.fff')) ffmpeg ended by itself, exit $($p.ExitCode)" }
