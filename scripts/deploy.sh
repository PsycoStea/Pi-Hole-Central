#!/usr/bin/env bash
#
# Deploy pihole-central on the LXC host: build the new image while the old
# container keeps serving, swap (~10 s of downtime), verify, then clean up.
#
# All persistent state lives in the ./data bind mount (SQLite DB + Teleporter
# backups), which Docker never touches, and there is only ever one container
# of this app on the host.
#
# Disk: the LXC root is ~9.8 GB. Measured 2026-11-09 (`docker buildx du`): a
# build leaves 2.7 GB of build cache, of which 1.15 GB is shared with the
# image's own layers, so pruning frees only the ~1.55 GB private part. Free
# after the prune is ~5.67 GiB; a build adds ~2.5 GiB (new image + private
# cache) while the old image is still present, ending ~3.2 GiB free. So:
#   1. prune the build cache first (no downtime: the running image is kept),
#   2. require MIN_FREE_GIB (default 5 = 2.5 build + 2 for the app's own
#      host-disk warning + 0.5 margin) free before building. If there isn't
#      room, fall back to the old wipe-first deploy (container down for the
#      whole 5-7 min build),
#   3. after the new container is verified, delete the old image and the cache.
#   WIPE_FIRST=1 forces the wipe-first path.
#
# A failed build must never look like a successful deploy. The old wipe-first
# design existed because an incremental build that died on "no space left on
# device" left the previous container serving HTTP 200 with nobody noticing.
# Here a failed build still leaves the old container running (that's the
# point), but the script exits non-zero and says loudly which commit is still
# live. Never treat a deploy as done without the "Deployed" line at the end.
#
# Post-deploy it VERIFIES that the NEW container is running and that its
# background poller started. On 2026-08-13 a Next.js standalone packaging bug
# meant instrumentation.js was missing: the server booted, served pages, and
# ran no polling, alerts, health checks or backups, with nothing in the logs.
#
# Usage: scripts/deploy.sh <full 40-char commit SHA>
#   The SHA is the commit you pushed, taken from your own checkout
#   (`git rev-parse HEAD`) and passed over the SSH session you run this in.
#   The script deploys exactly that commit or nothing: it fetches, checks that
#   origin/main IS that commit and that it fast-forwards from what is live,
#   and only then checks it out and re-executes itself from it. Security audit
#   R4-NV2: this runs as root, so whatever commit arrives runs as root, and the
#   LAN is flat with less-trusted devices on it. The remote must be SSH (pinned
#   host key); plain http/git:// remotes are refused.
#   DEPLOY_VERIFY_ONLY=1 stops after the checks (no checkout, no Docker).
set -euo pipefail

SELF=$(realpath "$0")
cd "$(dirname "$SELF")/.."

CONTAINER=pihole-central-pihole-central-1
IMAGE=pihole-central-pihole-central
MIN_FREE_GIB=${MIN_FREE_GIB:-5}

EXPECTED_SHA=${1:-}
if ! [[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "!!  Usage: $0 <full 40-character commit SHA to deploy>" >&2
  echo "!!  Run 'git rev-parse HEAD' in your checkout after pushing, and pass that." >&2
  exit 2
fi

# --- 1. fetch, verify, fast-forward, then re-exec from the verified commit ---
# Bash reads a script as it runs; a checkout that changes this file would
# otherwise leave the OLD version executing the rest of the deploy.
if [ -z "${DEPLOY_REEXEC:-}" ]; then
  ORIGIN_URL=$(git remote get-url origin)
  case "$ORIGIN_URL" in
    http://*|git://*)
      echo "!!  REFUSED: origin is $ORIGIN_URL (unauthenticated transport)." >&2
      echo "!!  Use the SSH remote with a pinned host key." >&2
      exit 1 ;;
  esac
  DEPLOY_OLD_SHA=$(git rev-parse HEAD)
  echo "==> Fetching origin/main (checkout at ${DEPLOY_OLD_SHA:0:7}, deploying ${EXPECTED_SHA:0:7})"
  git fetch --no-tags origin main
  FETCHED_SHA=$(git rev-parse FETCH_HEAD)
  if [ "$FETCHED_SHA" != "$EXPECTED_SHA" ]; then
    echo "!!  REFUSED: origin/main is $FETCHED_SHA, not the expected $EXPECTED_SHA." >&2
    echo "!!  Nothing was checked out. Push first, or pass the SHA of what is on main." >&2
    exit 1
  fi
  LIVE_SHA=$(cat .deployed-sha 2>/dev/null || true)
  for base in "$DEPLOY_OLD_SHA" ${LIVE_SHA:+"$LIVE_SHA"}; do
    if ! git merge-base --is-ancestor "$base" "$EXPECTED_SHA"; then
      echo "!!  REFUSED: $EXPECTED_SHA does not fast-forward from $base." >&2
      echo "!!  History on main is only ever added to (roll back with git revert)." >&2
      exit 1
    fi
  done
  if [ "${DEPLOY_VERIFY_ONLY:-}" = "1" ]; then
    echo "==> VERIFY ONLY: $EXPECTED_SHA is origin/main and fast-forwards from what is live. Stopping."
    exit 0
  fi
  git merge --ff-only --quiet "$EXPECTED_SHA"
  DEPLOY_REEXEC=1 DEPLOY_OLD_SHA=$DEPLOY_OLD_SHA exec "$SELF" "$@"
fi
# Re-executed from the new checkout: it must be exactly the verified commit.
if [ "$(git rev-parse HEAD)" != "$EXPECTED_SHA" ]; then
  echo "!!  REFUSED: checkout is $(git rev-parse HEAD), expected $EXPECTED_SHA." >&2
  exit 1
fi
NEW_SHA=$EXPECTED_SHA
# What is actually live: recorded by the last successful deploy. HEAD-before-pull
# is wrong after a failed build (the checkout already moved) or a manual pull.
OLD_SHA=$(cat .deployed-sha 2>/dev/null || echo "${DEPLOY_OLD_SHA:-unknown}")

free_gib() { df --output=avail -B1 / | tail -1 | awk '{printf "%.2f", $1/1073741824}'; }

echo "==> Free space before: $(free_gib) GiB"
df -h / | tail -1

wait_for_poller() {
  # The poller is the whole point of this app. If instrumentation is missing it
  # will never log this line, and everything else will still look healthy.
  local since=$1
  for _ in $(seq 1 30); do
    if docker logs --since "$since" "$CONTAINER" 2>&1 | grep -q "poller] Starting background polling"; then
      echo "    ok: poller started"
      return 0
    fi
    sleep 2
  done
  echo "!!  FAILED: background poller never started."
  echo "!!  The app will serve pages but do NO polling, alerting, health checks or backups."
  echo "!!  Check that .next/server/instrumentation.js made it into the standalone build."
  docker logs --tail 40 "$CONTAINER" 2>&1 || true
  return 1
}

backup_db() {
  # Consistent copy of the live DB (SQLite online backup API, WAL-safe), taken
  # from the running OLD container before the new one runs its migrations.
  # The migrator runs at container start, so a bad migration would otherwise
  # leave no pre-migration copy. Keeps only the newest pre-deploy copy, 0600.
  if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)" != "true" ]; then
    echo "    no running container: skipping the pre-deploy DB backup"
    return 0
  fi
  local name
  name="pre-deploy-${NEW_SHA:0:7}-$(date -u +%Y%m%dT%H%M%SZ).db"
  echo "==> Backing up the database to data/$name"
  if ! docker exec -i -e BK_NAME="$name" "$CONTAINER" sh -c 'umask 077 && node -' <<'JS'
const Database = require('better-sqlite3')
const src = new Database('/app/data/pihole-central.db', { readonly: true, fileMustExist: true })
const dest = '/app/data/' + process.env.BK_NAME
src.backup(dest).then(() => {
  src.close()
  // The copy inherits WAL mode; switch it to a single self-contained file so
  // opening it never leaves -wal/-shm side files behind.
  const copy = new Database(dest)
  copy.pragma('journal_mode = DELETE')
  const ok = copy.pragma('quick_check', { simple: true })
  copy.close()
  if (ok !== 'ok') { console.error('quick_check: ' + ok); process.exit(1) }
}).catch((e) => { console.error(e); process.exit(1) })
JS
  then
    echo "!!  DB BACKUP FAILED. Nothing was swapped; the old container is still serving." >&2
    rm -f "data/$name" "data/$name-wal" "data/$name-shm"
    return 1
  fi
  find data -maxdepth 1 -name 'pre-deploy-*.db*' ! -name "$name" -delete
  echo "    ok: $(du -h "data/$name" | cut -f1), quick_check ok"
}

finish() {
  echo "$NEW_SHA" > .deployed-sha
  echo "==> Free space after: $(free_gib) GiB"
  df -h / | tail -1
  echo "==> Deployed $NEW_SHA (was $OLD_SHA)"
  docker ps --filter "name=$CONTAINER" --format '    {{.Names}}  {{.Status}}'
}

# --- wipe-first path (fallback, or WIPE_FIRST=1) ---
deploy_wipe_first() {
  echo "==> WIPE-FIRST deploy: the dashboard is down until the build finishes (5-7 min)"
  backup_db
  docker compose down --remove-orphans
  docker system prune -af
  local since
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  docker compose up -d --build
  echo "==> Waiting for the background poller to start"
  wait_for_poller "$since"
  finish
}

if [ "${WIPE_FIRST:-}" = "1" ]; then
  deploy_wipe_first
  exit 0
fi

# --- 2. make room without downtime ---
echo "==> Pruning build cache (the running container and its image are kept)"
docker builder prune -af >/dev/null
docker image prune -f >/dev/null   # dangling images only, never the running one

FREE=$(free_gib)
if awk -v f="$FREE" -v m="$MIN_FREE_GIB" 'BEGIN { exit !(f < m) }'; then
  echo "!!  Only $FREE GiB free; build-first needs $MIN_FREE_GIB GiB. Falling back to wipe-first."
  deploy_wipe_first
  exit 0
fi
echo "    $FREE GiB free (need $MIN_FREE_GIB): building alongside the running container"

# --- 3. build while the old container keeps serving ---
OLD_IMAGE_ID=$(docker inspect -f '{{.Image}}' "$CONTAINER" 2>/dev/null || true)
if [ -n "$OLD_IMAGE_ID" ]; then
  # Keep a handle on the running image: the build moves :latest to the new one.
  docker tag "$OLD_IMAGE_ID" "$IMAGE:previous"
fi

echo "==> Building $NEW_SHA"
if ! docker compose build; then
  echo "!!  BUILD FAILED. Nothing was swapped: the dashboard is still running the OLD build ($OLD_SHA),"
  echo "!!  but the checkout is now at $NEW_SHA. Fix the build and re-run this script."
  echo "!!  Free space now: $(free_gib) GiB (run 'docker builder prune -af' if a full disk caused this)."
  exit 1
fi
NEW_IMAGE_ID=$(docker image inspect -f '{{.Id}}' "$IMAGE:latest")

# --- 4. back up the DB, then swap ---
if ! backup_db; then
  exit 1
fi
echo "==> Swapping containers"
SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
rollback_hint() {
  if [ -n "$OLD_IMAGE_ID" ]; then
    echo "!!  The previous image is kept as $IMAGE:previous ($OLD_SHA). To go back to it:"
    echo "!!    docker tag $IMAGE:previous $IMAGE:latest && docker compose up -d --no-build"
    echo "!!  then revert the bad commit on main (git revert) so the next deploy doesn't repeat it."
  fi
}
if ! docker compose up -d --no-build --remove-orphans; then
  echo "!!  FAILED: could not start the new container."
  rollback_hint
  exit 1
fi

RUNNING_IMAGE_ID=$(docker inspect -f '{{.Image}}' "$CONTAINER" 2>/dev/null || true)
if [ "$RUNNING_IMAGE_ID" != "$NEW_IMAGE_ID" ]; then
  echo "!!  FAILED: $CONTAINER is not running the image just built."
  echo "!!  running: ${RUNNING_IMAGE_ID:-none}   built: $NEW_IMAGE_ID"
  rollback_hint
  exit 1
fi

echo "==> Waiting for the background poller to start"
if ! wait_for_poller "$SINCE"; then
  rollback_hint
  exit 1
fi

# --- 5. clean up only after the new container is verified ---
echo "==> Removing the previous image and build cache"
# Removes the old image, or just the tag if the build produced the same image.
docker rmi "$IMAGE:previous" >/dev/null 2>&1 || true
docker image prune -f >/dev/null
docker builder prune -af >/dev/null

finish
