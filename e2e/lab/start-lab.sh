#!/usr/bin/env bash
#
# Local lab: two mock Pi-holes (:18081 Node-1, :18082 Node-2), a mock sshd (:18022,
# control :18023) + `next dev` on :3999
# against a throwaway SQLite DB (migrated + seeded exactly like docker-entrypoint.sh).
# Never touches the live LXC or real Pi-holes.
#
#   e2e/lab/start-lab.sh [LAB_DIR]     # default LAB_DIR: /tmp/pihole-central-lab
#   npm run test:e2e                   # then run the Playwright suite against it
#   e2e/lab/stop-lab.sh [LAB_DIR]
#
# `next dev` rewrites AGENTS.md; run `git checkout AGENTS.md` before committing.
set -euo pipefail
cd "$(dirname "$0")/../.."
LAB=${1:-/tmp/pihole-central-lab}
mkdir -p "$LAB"

export DATABASE_URL="file:$LAB/test.db"
NEXTAUTH_SECRET=$(openssl rand -base64 32); export NEXTAUTH_SECRET
ENCRYPTION_KEY=$(openssl rand -base64 32); export ENCRYPTION_KEY
export NEXTAUTH_URL=http://127.0.0.1:3999
export AUTH_TRUST_HOST=true
export SSH_KEY_PATH=/dev/null
# All lab SSH (both instances are 127.0.0.1) goes to the mock sshd.
export SSH_PORT=18022

# A lab server left over from an earlier run would answer on these ports with its
# own (deleted but still open) DB, and every check below would pass against it.
for port in 3999 18081 18082 18022 18023; do
  if ss -ltn "sport = :$port" | grep -q LISTEN; then
    echo "port $port is already in use: run e2e/lab/stop-lab.sh first (or find the owner: ss -ltnp 'sport = :$port')" >&2
    exit 1
  fi
done

rm -f "$LAB"/test.db*
# migrations + seed = the entrypoint minus its final `exec node server.js`
sed '$d' docker-entrypoint.sh | sh > "$LAB/seed.log" 2>&1

# Each in its own session, so stop-lab.sh can kill the whole process group:
# next dev runs as npx -> next -> next-server, and killing only the top pid
# orphaned the server, still holding :3999.
setsid nohup node e2e/lab/mock-pihole.mjs 18081 node1 > "$LAB/mock1.log" 2>&1 < /dev/null & echo $! > "$LAB/mock1.pid"
setsid nohup node e2e/lab/mock-pihole.mjs 18082 node2 > "$LAB/mock2.log" 2>&1 < /dev/null & echo $! > "$LAB/mock2.pid"
setsid nohup node e2e/lab/mock-sshd.mjs 18022 18023 > "$LAB/sshd.log" 2>&1 < /dev/null & echo $! > "$LAB/sshd.pid"
setsid nohup npx next dev -p 3999 -H 127.0.0.1 > "$LAB/dev.log" 2>&1 < /dev/null & echo $! > "$LAB/dev.pid"

for _ in $(seq 1 90); do
  curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3999/login 2>/dev/null | grep -q 200 && { echo "lab up (logs in $LAB)"; exit 0; }
  sleep 2
done
echo "next dev did not come up; see $LAB/dev.log" >&2
exit 1
