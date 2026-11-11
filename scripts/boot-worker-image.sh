#!/usr/bin/env bash
# Starts a built worker image the way production runs it, next to a Redis, and requires the worker to come up and to stop cleanly
# (docs/policy-decisions.md, entry 232). The deploy workflow runs it on the worker image before it pushes the web image tag, so a
# build whose worker cannot start in the production container is never deployable.
#
#   scripts/boot-worker-image.sh <image>
#
# The flags are those of the worker service in docker-compose.prod.yml: read-only root, no capabilities, uid 10001, no new privileges,
# the worker seccomp profile, and noexec tmpfs where production mounts its scratch. The AppArmor profile is left out: it is loaded on
# the production host only. The Redis is the image that compose pins, with a random password, on a network of its own that has no
# route out; the secrets are random values made for this run and the storage is local.
# The worker passes when its own healthcheck (scripts/worker-healthcheck.js: a fresh heartbeat file) succeeds while it still runs, and
# when SIGTERM ends it with exit status 0, which is the drain of src/worker/index.ts finishing. It proves that the worker starts and
# stops, not that it converts (scripts/verify-worker-container.sh does that in CI).
set -euo pipefail

IMAGE="${1:?usage: boot-worker-image.sh <image>}"
SUFFIX="$$"
NETWORK="easyconvert-worker-boot-$SUFFIX"
REDIS_NAME="easyconvert-worker-boot-redis-$SUFFIX"
WORKER_NAME="easyconvert-worker-boot-$SUFFIX"
ATTEMPTS="${BOOT_CHECK_ATTEMPTS:-60}"
STOP_SECONDS="${BOOT_CHECK_STOP_SECONDS:-60}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SECCOMP="$ROOT/docker/seccomp-worker.json"
COMPOSE="$ROOT/docker-compose.prod.yml"

for value in "$ATTEMPTS" "$STOP_SECONDS"; do
  if ! [[ "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "worker boot check: BOOT_CHECK_ATTEMPTS and BOOT_CHECK_STOP_SECONDS must be whole numbers of at least 1, not '$value'" >&2
    exit 2
  fi
done

# The Redis image is the one production runs: its tag and digest are read from the compose file, never written a second time here.
REDIS_IMAGE="$(grep -Eo 'redis:[0-9][^[:space:]]*@sha256:[0-9a-f]{64}' "$COMPOSE" | head -n 1 || true)"
if [ -z "$REDIS_IMAGE" ]; then
  echo "worker boot check: $COMPOSE names no digest-pinned redis image" >&2
  exit 2
fi

secret() { openssl rand -hex 32; }

cleanup() {
  docker rm -f "$WORKER_NAME" "$REDIS_NAME" > /dev/null 2>&1 || true
  docker network rm "$NETWORK" > /dev/null 2>&1 || true
}
trap cleanup EXIT

fail_with_logs() {
  echo "worker boot check: $1" >&2
  docker logs --tail 60 "$WORKER_NAME" >&2 || true
  exit 1
}

redis_password="$(secret)"
docker network create --internal "$NETWORK" > /dev/null
docker run --detach --name "$REDIS_NAME" --network "$NETWORK" --network-alias redis \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:size=16m,noexec,nosuid,nodev,uid=999,gid=1000,mode=0700 \
  --env "REDIS_PASSWORD=$redis_password" \
  "$REDIS_IMAGE" sh -c 'umask 077; { printf "requirepass \""; printf "%s" "$REDIS_PASSWORD"; printf "\"\n"; } > /tmp/redis.conf; exec redis-server /tmp/redis.conf --save "" --appendonly no' > /dev/null

docker run --detach --name "$WORKER_NAME" --network "$NETWORK" \
  --read-only \
  --cap-drop ALL \
  --user 10001:10001 \
  --security-opt no-new-privileges:true \
  --security-opt "seccomp=$SECCOMP" \
  --tmpfs /tmp:size=256m,noexec,nosuid,nodev,uid=10001,gid=10001,mode=0750 \
  --tmpfs /home/easyconvert:size=512m,noexec,nosuid,nodev,uid=10001,gid=10001,mode=0750 \
  --tmpfs /shared/storage:size=64m,noexec,nosuid,nodev,uid=10001,gid=10001,mode=0750 \
  --env NODE_ENV=production \
  --env APP_URL=http://127.0.0.1:3000 \
  --env STORAGE_DRIVER=local \
  --env EASYCONVERT_STORAGE_DIR=/shared/storage \
  --env STRICT_SANDBOX=true \
  --env WORKER_HEARTBEAT_FILE=/home/easyconvert/worker-heartbeat.json \
  --env "REDIS_URL=redis://:$redis_password@redis:6379" \
  --env "JWT_SECRET=$(secret)" \
  --env "KEY_HASH_PEPPER=$(secret)" \
  --env "WEBHOOK_SECRET_KEK=$(secret)" \
  --env "STORAGE_SIGNING_SECRET=$(secret)" \
  --env "JOB_SECRET_KEK=$(secret)" \
  "$IMAGE" > /dev/null

healthy=false
for ((attempt = 1; attempt <= ATTEMPTS; attempt++)); do
  if [ "$(docker inspect --format '{{.State.Running}}' "$WORKER_NAME")" != true ]; then
    fail_with_logs "the worker exited before it became healthy (exit code $(docker inspect --format '{{.State.ExitCode}}' "$WORKER_NAME"))"
  fi
  if docker exec "$WORKER_NAME" node scripts/worker-healthcheck.js > /dev/null 2>&1; then
    healthy=true
    echo "worker boot check: the worker healthcheck passed after $attempt attempt(s)"
    break
  fi
  sleep 2
done
[ "$healthy" = true ] || fail_with_logs "the worker healthcheck did not pass within $ATTEMPTS attempts"

# The listening line is the last statement of src/worker/index.ts: seeing it means every module of the worker loaded and its start-up
# ran to the end (the heartbeat file alone is written earlier).
online=false
for ((attempt = 1; attempt <= ATTEMPTS; attempt++)); do
  if docker logs "$WORKER_NAME" 2>&1 | grep -q 'Worker daemon online and listening for jobs'; then
    online=true
    break
  fi
  if [ "$(docker inspect --format '{{.State.Running}}' "$WORKER_NAME")" != true ]; then
    fail_with_logs "the worker stopped before it reported that it listens for jobs"
  fi
  sleep 1
done
[ "$online" = true ] || fail_with_logs "the worker did not report that it listens for jobs"

docker stop --timeout "$STOP_SECONDS" "$WORKER_NAME" > /dev/null
code="$(docker inspect --format '{{.State.ExitCode}}' "$WORKER_NAME")"
if [ "$code" != 0 ]; then
  fail_with_logs "SIGTERM ended the worker with exit code $code, not 0 (a clean drain)"
fi
echo "worker boot check: the worker listened for jobs and stopped cleanly on SIGTERM"
