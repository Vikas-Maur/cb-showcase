# P10 on NTFS (PLAN §6.4 [GATE]): the portable matrix on the shipped @carton/cardboard code. Run on the laptop, on
# mains power (AGENTS.md: on battery Windows throttles about 3x), from this folder:
#   powershell -ExecutionPolicy Bypass -File run-windows.ps1                       # %TEMP% (NTFS)
#   powershell -ExecutionPolicy Bypass -File run-windows.ps1 -Dir D:\carton-race   # another volume
#   powershell -ExecutionPolicy Bypass -File run-windows.ps1 -Trials 5 -Rounds 5000
# It writes results-windows-<date>.jsonl next to this script and prints the table plus "N of M foreign writes lost
# by the engine" per protocol. A FAT/exFAT volume has no hard links: the script says so and runs `naive` only.
param(
  [string]$Dir = (Join-Path $env:TEMP 'carton-race'),
  [int]$Trials = 3,
  [int]$Rounds = 3000
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$node = (Get-Command node).Source
$ver = & $node --version
if ([int]($ver -replace '^v(\d+)\..*', '$1') -lt 24) { throw "Node 24 or later is needed (found $ver): it runs .ts files directly." }
$power = (Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus -ErrorAction SilentlyContinue | Select-Object -First 1).PowerOnline
if ($power -eq $false) { Write-Warning 'On battery: Windows throttles the laptop, so timings are not comparable. Plug in for the gate run.' }
$fsType = try { (Get-Volume -FilePath (New-Item -ItemType Directory -Force $Dir).FullName).FileSystemType } catch { 'unknown' }
$out = Join-Path $PSScriptRoot ("results-windows-{0}.jsonl" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
Write-Host "NTFS race gate: dir $Dir ($fsType), $Trials trials x $Rounds rounds, node $ver, mains: $power"
& $node race.ts --dir $Dir --fs "windows-$fsType" --trials $Trials --rounds $Rounds --out $out
if ($LASTEXITCODE -ne 0) { throw "race.ts failed ($LASTEXITCODE)" }
& $node summarize.ts $out
Write-Host "Raw results: $out"
