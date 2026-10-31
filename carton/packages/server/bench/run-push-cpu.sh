#!/usr/bin/env bash
# Three runs of the CPU-per-push A/B (push-cpu.ts), each inside the box's CPU lock, with the load recorded before
# each run. Results: packages/server/bench/results/push-cpu-run<N>.json and push-cpu-runs.log. Run from carton/.
set -euo pipefail
LOG=packages/server/bench/results/push-cpu-runs.log
mkdir -p packages/server/bench/results
for run in 1 2 3; do
  flock /tmp/gfv-race/cpu.lock bash -c "echo \"run $run start \$(date -Is) load \$(cut -d' ' -f1-3 /proc/loadavg)\" >> $LOG; node packages/server/bench/push-cpu.ts $run ${PUSHES:-3000} >> $LOG 2>&1; echo \"run $run end \$(date -Is) load \$(cut -d' ' -f1-3 /proc/loadavg)\" >> $LOG"
done
