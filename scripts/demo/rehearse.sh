#!/bin/bash
# A rehearsal from this box: a sharing server (the local one on 127.0.0.1, or --host <url> for the live one), Vikas
# playing the Windows app (a project with a short clip, shared), Sam joining from its invite, then a cue sheet
# (default rehearsal-cues.yaml) driving both sides. Logs: $DEMO_DIR/runs/. Leaves everyone running; stop with --stop.
#   scripts/demo/rehearse.sh [--host <url>] [--project "Demo rehearsal"] [--cues <file>] [--keep] [--stop]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export DEMO_DIR="${DEMO_DIR:-$HOME/gfv-scratch/carton/demo}"
export TMPDIR="${TMPDIR:-$DEMO_DIR/tmp}"
mkdir -p "$TMPDIR"
host="" project="Demo rehearsal" cues="$here/rehearsal-cues.yaml" keep=0
while [ $# -gt 0 ]; do
  case "$1" in
    --host) host="$2"; shift 2 ;;
    --project) project="$2"; shift 2 ;;
    --cues) cues="$2"; shift 2 ;;
    --keep) keep=1; shift ;;
    --stop) for p in Sam Vikas; do PEER="$p" "$here/peer" leave 2>/dev/null || true; done; "$here/peer" host stop; exit 0 ;;
    *) echo "unknown: $1" >&2; exit 2 ;;
  esac
done
peer() { "$here/peer" "$@"; }
[ -f "$DEMO_DIR/build/build.json" ] || peer setup
if [ $keep = 0 ]; then
  for p in Sam Vikas; do PEER="$p" peer leave >/dev/null 2>&1 || true; done
  sleep 0.5
  stamp=$(date -u +%Y%m%dT%H%M%S)
  for d in peer-sam peer-vikas; do [ -d "$DEMO_DIR/$d" ] && mkdir -p "$DEMO_DIR/old" && mv "$DEMO_DIR/$d" "$DEMO_DIR/old/$d-$stamp"; done
  if [ -z "$host" ]; then
    peer host stop >/dev/null || true
    [ -d "$DEMO_DIR/host" ] && mv "$DEMO_DIR/host" "$DEMO_DIR/old/host-$stamp"
    peer host start
  fi
  peer app --name Vikas
  peer --peer Vikas create "$project"
  if [ -n "$host" ]; then peer --peer Vikas share --host "$host"; else peer --peer Vikas share; fi
  link=$(peer --peer Vikas invite)
  peer join "$link" --name Sam
fi
peer run "$cues" --peer Sam
