#!/bin/bash
# timing-b6.sh: Update 6b item 5, timing B on out/carton-prod5 (Carton on vs off), agents' cb print+apply latency with the
# app open and nobody editing (lat.sh → writers.js run --writers W --rate 1 --seconds 60 --out results/p6b/lat-<label>.json,
# which now keeps every edit's time in `samples`). 3 runs a side at 4 and at 1 writer; within each pair the order alternates,
# and the W=1 pairs start opposite to the W=4 ones, so Carton on goes first in exactly half of the 6 pairs.
# Node's compile cache (<os temp>/node-compile-cache) is warmed first with one cb command per mode. Before each run: on
# mains, ≥ 8.5 GB free on C: and D:, nobody at the laptop for 2 minutes, and no other Cardboard running (else wait). After
# each run, input during it marks it TAINTED in the log. Log: results/p6b/timing.log
cd /d/cbwork/carton
mkdir -p results/p6b
log=results/p6b/timing.log
B=carton-prod5
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
note "start timing B on $B ($(node -e 'console.log(require("D:/Projects/cardboard-showcase/out/carton-prod5/Cardboard-win/build-info.json").commit.slice(0,8))'))"
mkdir -p profiles/warm6b/userdata profiles/warm6b/home
for m in on off; do node cb.js $B warm6b $m project list >/dev/null 2>&1; done; rm -rf profiles/warm6b
note "compile cache warmed (one cb project list per mode)"
for rep in 1 2 3; do
  for W in 4 1; do
    if [ $W = 4 ]; then case $rep in 1) o="on off";; 2) o="off on";; 3) o="on off";; esac
    else case $rep in 1) o="off on";; 2) o="on off";; 3) o="off on";; esac; fi
    for s in $o; do
      guard; L="b6-$s-w$W-r$rep"; note "B $L"
      bash lat.sh $s open $W 60 $L $B >> $log 2>&1
      check $L
      mv -f results/lat-$L.json results/lat-$L.log results/p6b/ 2>/dev/null
    done
  done
done
note "done"
