#!/bin/bash
# timing-b8.sh: Update 8 item 3, diagnostic timing B on out/carton-prod6 (66ee2f3f), Carton on vs off, agents' cb print+apply
# with the app open and nobody editing (lat8.sh → writers.js --out results/p8/lat-<label>.json, with per-edit print/apply
# and the apply's timeline answer; plus each run's activity log). 6 pairs at 4 writers and 6 at 1 writer (24 runs, 60 s
# each); within each pair the order alternates, and the W=1 pairs start opposite to the W=4 ones, so Carton on goes first
# in exactly half of each writer count's pairs. Node's compile cache is warmed first with one cb command per mode. The
# network stays on. Before each run: on mains, ≥ 8.5 GB free on C: and D:, no other Cardboard running, nobody at the laptop
# for 2 minutes (else wait). After each run, input during it marks it TAINTED. Log: results/p8/timing.log
cd /d/cbwork/carton
mkdir -p results/p8
log=results/p8/timing.log
B=carton-prod6
power() { powershell -NoProfile -Command "(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Select -First 1).PowerOnline" | tr -d '\r'; }
note() { echo "$(date -u +%T) $*" | tee -a $log; }
free() { powershell -NoProfile -Command "[math]::Floor([math]::Min((Get-PSDrive D).Free, (Get-PSDrive C).Free)/1MB)" | tr -d '\r'; }
idle() { powershell -NoProfile -ExecutionPolicy Bypass -File 'D:\cbwork\scripts\idle.ps1' | sed -E 's/^idle=([0-9]+).*/\1/' | tr -d '\r'; }
apps() { tasklist //FI "IMAGENAME eq Cardboard.exe" 2>/dev/null | grep -c Cardboard; }
guard() {
  while [ "$(power)" != "True" ]; do note "on battery: waiting"; sleep 60; done
  f=$(free); if [ "$f" -lt 8704 ]; then note "STOP: only $f MB free"; exit 1; fi
  while [ "$(apps)" -gt 0 ]; do note "another Cardboard is running: waiting"; sleep 30; done
  while [ "$(idle)" -lt 120 ]; do note "someone is using the laptop: waiting"; sleep 60; done
  t0=$(date +%s)
}
check() { i=$(idle); d=$(( $(date +%s) - t0 )); if [ "$i" -lt "$d" ]; then note "TAINTED $1 (input ${i}s ago, run took ${d}s)"; else note "clean $1 (${d}s)"; fi; }
note "start timing B (Update 8) on $B ($(node -e 'console.log(require("D:/Projects/cardboard-showcase/out/carton-prod6/Cardboard-win/build-info.json").commit.slice(0,8))'))"
mkdir -p profiles/warm8/userdata profiles/warm8/home
for m in on off; do node cb.js $B warm8 $m project list >/dev/null 2>&1; done; rm -rf profiles/warm8
note "compile cache warmed (one cb project list per mode)"
for rep in 1 2 3 4 5 6; do
  for W in 4 1; do
    if [ $W = 4 ]; then [ $((rep % 2)) = 1 ] && o="on off" || o="off on"
    else [ $((rep % 2)) = 1 ] && o="off on" || o="on off"; fi
    for s in $o; do
      guard; L="b8-$s-w$W-r$rep"; note "B $L"
      bash lat8.sh $s $W 60 $L $B >> $log 2>&1
      check $L
    done
  done
done
note "done"
