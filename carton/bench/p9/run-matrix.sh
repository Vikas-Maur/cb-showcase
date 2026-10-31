#!/usr/bin/env bash
# The full P9 matrix, one configuration per CPU-lock hold (other agents' timed benchmarks run in between), then one
# merged summary per set. Run from carton/. Output: bench/p9/results/<set>/<config>-runs.jsonl and <set>-summary.*
set -euo pipefail
SEEDS=${SEEDS:-30}; SEED0=${SEED0:-1}; SET=${SET:-main}
DIR=bench/p9/results/$SET
mkdir -p "$DIR"
files=()
run() { # name, args...
  local name=$1; shift
  flock /tmp/gfv-race/cpu.lock node bench/p9/run.ts --seeds "$SEEDS" --seed0 "$SEED0" --no-s2 --out "$DIR/$name" "$@" > "$DIR/$name.log" 2>&1
  files+=("$DIR/$name-runs.jsonl")
}
for rtt in 300 50; do
  for k in v2-layout v3-spans per-item; do run "$k-$rtt" --keying $k --rtt $rtt; done
  if [ "${SENSITIVITY:-0}" = 1 ]; then
    run "v3-spans-v10-$rtt" --keying v3-spans-v10 --rtt $rtt
    j=$((rtt / 5))
    run "v3-spans-v10-$rtt-jitter" --keying v3-spans-v10 --rtt $rtt --jitter $j
    for k in v2-layout v3-spans per-item; do run "$k-$rtt-one-push" --keying $k --rtt $rtt --one-push; run "$k-$rtt-jitter" --keying $k --rtt $rtt --jitter $j; done
  fi
done
list=$(IFS=,; echo "${files[*]}")
flock /tmp/gfv-race/cpu.lock node bench/p9/run.ts --merge "$list" --out "bench/p9/results/$SET" > "bench/p9/results/$SET.log" 2>&1
echo "done: bench/p9/results/$SET-summary.md"
