#!/usr/bin/env bash
# P10 on Linux, on the shipped @carton/cardboard code: free mode with the inotify oracle, turn mode, in-place writers
# (settle 0, 1 and the shipped settle 2), and the missing-path gap. Each trial holds the shared CPU lock
# (/tmp/gfv-race/cpu.lock), so it never overlaps another agent's benchmark, and records `uptime` before it runs.
#   ./run-linux.sh <out.jsonl> [trials] [rounds] [dir...]     dirs default to $HOME/gfv-scratch/carton/race (the
#                                                            scratch disk); pass e.g. tmpfs:/tmp/x ext4:/var/tmp/x
# The oracle is built on first use: cc -O2 -o inotify-log inotify-log.c
set -euo pipefail
cd "$(dirname "$0")"
OUT=$(realpath -m "$1"); N=${2:-3}; R=${3:-3000}; shift $(( $# < 3 ? $# : 3 )) || true
DIRS=("$@"); [ ${#DIRS[@]} -eq 0 ] && DIRS=("disk:$HOME/gfv-scratch/carton/race")
mkdir -p /tmp/gfv-race "$(dirname "$OUT")"
[ -x ./inotify-log ] || cc -O2 -o inotify-log inotify-log.c
UP="${OUT%.jsonl}.uptime.log"
run() {
  # -o: the lock fd is not inherited by the trial's children. --resume skips trials already in OUT.
  flock -o /tmp/gfv-race/cpu.lock bash -c 'echo "$(date -Is) $(uptime) :: $*" >> "$0"; exec node race.ts trial "$@" --out "'"$OUT"'" --resume > /dev/null' "$UP" "$@"
}
for fsd in "${DIRS[@]}"; do
  F=${fsd%%:*}; D=${fsd#*:}; mkdir -p "$D"
  for p in naive hardlink displace; do
    for w in 1 4; do for wd in 0 100; do
      run --fs "$F" --dir "$D" --mode free --protocol $p --writers $w --widen $wd --rounds "$R" --trials "$N" --oracle ./inotify-log
      run --fs "$F" --dir "$D" --mode turn --protocol $p --writers $w --widen $wd --rounds "$R" --trials "$N"
    done; done
    run --fs "$F" --dir "$D" --mode turn --style inplace --protocol $p --writers 1 --rounds "$R" --trials "$N"
  done
  for sl in 1 2; do run --fs "$F" --dir "$D" --mode turn --style inplace --protocol displace --settle $sl --writers 1 --rounds "$R" --trials "$N"; done
  for e in sync async; do for rd in read stat; do
    run --fs "$F" --dir "$D" --protocol displace --engine $e --writers 0 --pace 2 --rounds 1000 --reader $rd --trials "$N"
  done; done
  echo "$F done"
done
node summarize.ts "$OUT"
