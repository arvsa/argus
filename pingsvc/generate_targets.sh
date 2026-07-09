#!/usr/bin/env bash
# generate_targets.sh
# Usage: ./generate_targets.sh 20000 targets.txt

# Default output path resolves relative to this script's own directory, not
# the caller's cwd -- README.md documents running this as
# ./pingsvc/generate_targets.sh from the repo root, which would otherwise
# silently write to <repo-root>/targets.txt instead of pingsvc/targets.txt
# (and Docker then auto-creates the missing bind-mount source as an empty
# directory there instead of erroring).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

COUNT=${1:-20000}
OUT=${2:-"$SCRIPT_DIR/targets.txt"}
> "$OUT"

# First use 10.0.0.0/8 (skip network and broadcast-like trivial hosts)
i=0
for a in $(seq 1 254); do
  for b in $(seq 0 255); do
    for c in $(seq 1 254); do
      echo "10.$a.$b.$c" >> "$OUT"
      i=$((i+1))
      if [ "$i" -ge "$COUNT" ]; then
        echo "Wrote $i targets to $OUT"
        exit 0
      fi
    done
  done
done

# Fall back to 192.168.x.y if still needed
for a in $(seq 0 255); do
  for b in $(seq 1 254); do
    echo "192.168.$a.$b" >> "$OUT"
    i=$((i+1))
    if [ "$i" -ge "$COUNT" ]; then
      echo "Wrote $i targets to $OUT"
      exit 0
    fi
  done
done
