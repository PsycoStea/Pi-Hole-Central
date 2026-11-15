#!/usr/bin/env bash
# Stop everything start-lab.sh started. Each process was started with setsid, so
# its pid is also its process-group id: kill the group, not just the top pid.
LAB=${1:-/tmp/pihole-central-lab}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
for f in mock1 mock2 sshd dev; do
  [ -f "$LAB/$f.pid" ] || continue
  kill -TERM -- "-$(cat "$LAB/$f.pid")" 2>/dev/null || true
  rm -f "$LAB/$f.pid"
done
sleep 1
# Belt and braces: anything of this repo's lab still around (an older run whose
# pid files are gone, or next build workers that outlived their parent; seen
# 2026-11-06: two orphans at ~95% CPU for 2+ days).
pkill -f "$REPO/node_modules/.bin/next dev -p 3999" 2>/dev/null || true
pkill -f "e2e/lab/mock-pihole.mjs 1808" 2>/dev/null || true
pkill -f "e2e/lab/mock-sshd.mjs 18022" 2>/dev/null || true
pkill -f "$REPO/node_modules/next/dist/compiled/jest-worker" 2>/dev/null || true
for port in 3999 18081 18082 18022 18023; do
  for pid in $(ss -ltnpH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2); do
    [ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" = "$REPO" ] && kill "$pid" 2>/dev/null
  done
done
echo "lab stopped"
