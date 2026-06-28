#!/usr/bin/env bash
# generate_targets.sh
# Usage: ./generate_targets.sh 20000 targets.txt

COUNT=${1:-20000}
OUT=${2:-targets.txt}
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
