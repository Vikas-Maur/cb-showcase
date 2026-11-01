#!/usr/bin/env bash
# Runs sync.ts over a matrix, one run at a time, waiting first until the shared box has CPU to spare: at least
# IDLE_MIN% idle over 2 s (default 45; the box is shared with other agents, and its load average counts their idle
# processes too). Each line of the matrix file: arguments for sync.ts. The idle share is logged with each run.
#   bench/cloudflare/run-matrix.sh matrix.txt
cd "$(dirname "$0")"
IDLE_MIN=${IDLE_MIN:-45}
idle() { read -r _ a b c d e f g _ < /proc/stat; t1=$((a+b+c+d+e+f+g)); i1=$((d+e)); sleep 2; read -r _ a b c d e f g _ < /proc/stat; t2=$((a+b+c+d+e+f+g)); i2=$((d+e)); echo $(( 100 * (i2 - i1) / (t2 - t1) )); }
while read -r line; do
  [ -z "$line" ] || [ "${line:0:1}" = "#" ] && continue
  for _ in $(seq 90); do i=$(idle); [ "$i" -ge "$IDLE_MIN" ] && break; sleep 8; done
  echo "=== $(date -u +%T) idle ${i}% load $(cut -d' ' -f1 /proc/loadavg): $line"
  node sync.ts $line 2>&1 | grep -v "^\[.*\]     at" | tail -3
done < "$1"
