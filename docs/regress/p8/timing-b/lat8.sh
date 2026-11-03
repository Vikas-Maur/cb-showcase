#!/bin/bash
# lat8.sh <on|off> <writers> <seconds> <label> <build>: lat.sh's "open" run (Update 8's diagnostic timing B), plus keeping
# the run's activity log. A fresh profile with "Carton gates" (writers.js setup), the app (Carton on or off) with the
# project open in its editor and nobody editing, then `writers.js run --writers N --rate 1 --seconds S --out`. Before the
# profile is deleted, its userdata\logs\activity-*.jsonl is copied to results/p8/lat-<label>-activity.jsonl (the
# worker's "[carton] a cb write waited …" lines, matched to slow trips by time).
carton=$1; W=$2; S=$3; label=$4; build=$5
cd /d/cbwork/carton
prof="lat-$label"; out=results/p8
rm -rf "profiles/$prof"; mkdir -p "profiles/$prof/userdata" "profiles/$prof/home" $out
sh wr.sh "$build" "$prof" "$carton" setup 'D:\cbwork\carton\media\clip.mp4' >/dev/null 2>&1
flag=""; [ "$carton" = on ] && flag="-Carton"
pid=$(powershell -NoProfile -ExecutionPolicy Bypass -Command "& D:\cbwork\carton\launch.ps1 -Build $build -Profile $prof -Port 9341 $flag" | cut -d' ' -f1)
for i in $(seq 1 60); do curl -s http://127.0.0.1:9341/json/list | grep -q app/home && break; sleep 0.5; done
sleep 3
(cd /d/cbbench/build && CDP_PORT=9341 node onboard.js >/dev/null 2>&1)
id=$(node cb.js "$build" "$prof" "$carton" project list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).find(p=>p.name==="Carton gates").id))')
node cb.js "$build" "$prof" "$carton" project open "$id" --focus >/dev/null
for i in $(seq 1 40); do curl -s http://127.0.0.1:9341/json/list | grep -q "app/editor/$id" && break; sleep 0.5; done
sleep 5
sh wr.sh "$build" "$prof" "$carton" run --writers "$W" --rate 1 --seconds "$S" --out "D:/cbwork/carton/$out/lat-$label.json" > "$out/lat-$label.log" 2>&1
MSYS_NO_PATHCONV=1 taskkill /PID "$pid" >/dev/null 2>&1
for i in $(seq 1 30); do tasklist //FI "PID eq $pid" 2>/dev/null | grep -q " $pid " || break; sleep 1; done
sleep 2; MSYS_NO_PATHCONV=1 taskkill /T /F /PID "$pid" >/dev/null 2>&1
cat profiles/$prof/userdata/logs/activity-*.jsonl > "$out/lat-$label-activity.jsonl" 2>/dev/null
rm -rf "profiles/$prof"
node -e 'const r=require(process.argv[1]);const s=Object.values(r.samples).flat();console.log(`'"$label"': edits ${s.length}, applied ${s.filter(x=>x.outcome==="applied").length}, failed ${r.failures.length}, trips>=3s ${s.filter(x=>x.ms>=3000).length}, lost ${r.lost}`)' "D:/cbwork/carton/$out/lat-$label.json"
