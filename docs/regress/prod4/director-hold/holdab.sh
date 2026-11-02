#!/bin/bash
# holdab.sh base | run <build> <tag>: the orchestrator's A/B for the agent-turn hold (Update 6 follow-up).
#   base: profile hold-base with project "Hold AB" (clip + W1–W6) made by carton-old's own cb with no app running and no
#         CLAUDECODE (a Terminal write, so no hook-less hold), then carton-old started once to onboard, then quit cleanly.
#   run:  a fresh copy of hold-base → hold-<tag>, <build> started on port 9348 (Carton on), then agent-path.js with the
#         exact ping recipe (MUTE_AFTER_MS=15000, WATCH_MS=40000), the agent's answer read from the chat, the app quit.
# Logs: D:\cbwork\regress\prod4\mine\hold-<tag>.log
cd /d/cbwork/carton
onboard() { for t in 1 2 3; do (cd /d/cbbench/build && CDP_PORT=9348 node onboard.js >/dev/null 2>&1); w=$(cd /d/cbbench/build && CDP_PORT=9348 node -e 'const h=require("./h");h.ev("tabs.html","innerWidth").then((w)=>{console.log(w);h.forget()},()=>{console.log(0);h.forget()})'); [ "${w:-0}" -gt 0 ] && return 0; sleep 2; done; return 1; }
quit() { MSYS_NO_PATHCONV=1 taskkill /PID $1 >/dev/null 2>&1; for i in $(seq 1 30); do tasklist //FI "PID eq $1" | grep -q " $1 " || return 0; sleep 1; done; MSYS_NO_PATHCONV=1 taskkill /T /F /PID $1 >/dev/null 2>&1; }
if [ "$1" = base ]; then
  rm -rf profiles/hold-base
  id=$(env -u CLAUDECODE node mkproj.js carton-old hold-base on "Hold AB" | tr -d '\r'); echo "$id" > /d/cbwork/tmp/hold-ab.id
  pid=$(powershell -NoProfile -ExecutionPolicy Bypass -Command "& D:\cbwork\carton\launch.ps1 -Build carton-old -Profile hold-base -Port 9348 -Carton" | cut -d' ' -f1)
  for i in $(seq 1 60); do curl -s http://127.0.0.1:9348/json/list | grep -q app/ && break; sleep 0.5; done; sleep 4
  onboard && echo "base onboarded, project $id" || echo "base onboarding FAILED"
  quit $pid; sleep 2; exit 0
fi
build=$2; tag=$3; prof=hold-$tag; id=$(cat /d/cbwork/tmp/hold-ab.id)
log=/d/cbwork/regress/prod4/mine/hold-$tag.log
rm -rf profiles/$prof; cp -r profiles/hold-base profiles/$prof
pid=$(powershell -NoProfile -ExecutionPolicy Bypass -Command "& D:\cbwork\carton\launch.ps1 -Build $build -Profile $prof -Port 9348 -Carton -Extra '--disable-backgrounding-occluded-windows --disable-renderer-backgrounding'" | cut -d' ' -f1)
for i in $(seq 1 60); do curl -s http://127.0.0.1:9348/json/list | grep -q app/ && break; sleep 0.5; done; sleep 4
onboard || echo "onboarding check failed" >> $log
echo "== $tag: build $build ($(node -e 'console.log(require("D:/Projects/cardboard-showcase/out/'$build'/Cardboard-win/build-info.json").commit.slice(0,8))')), profile copy of hold-base, project $id" > $log
export AP_ID=$id AP_NAME="Hold AB" WATCH_MS=40000 MUTE_AFTER_MS=15000
export AGENT_PROMPT='First run `cb source print` for this project. Then run `ping -n 31 127.0.0.1` in the shell and wait for it to finish (run it in the foreground, not in the background). Then set W2'"'"'s font size to 321 with `cb source apply`, then immediately read `timeline.tsx` and tell me W2'"'"'s font size there and whether the clip on the Mine track is muted there.'
timeout 420 node agent-path.js 9348 $build $prof "Opus 5.5" 300 >> $log 2>&1
echo "-- agent's answer:" >> $log; node /d/cbwork/tmp/chat.js 9348 $id 2>&1 | tail -9 >> $log
quit $pid
