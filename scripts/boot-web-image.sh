#!/usr/bin/env bash
# Starts a built web image the way production runs it and requires `next start` to answer HTTP (docs/policy-decisions.md, entry 141).
# The deploy workflow runs it on the image it just built, before it pushes any tag, so an image that cannot start in the production
# container is never deployable.
#
#   scripts/boot-web-image.sh <image>
#
# The flags are those of the web service in docker-compose.prod.yml: read-only root, no capabilities, uid 10001, no new privileges,
# the worker seccomp profile, and noexec tmpfs where production mounts its scratch (/tmp and /home/easyconvert) and the build cache.
# The AppArmor profile is left out: it is loaded on the production host only. The secrets are random values made for this run, the
# storage is local, and there is no Redis, so the check proves that the server starts and serves a page, not that it converts.
set -euo pipefail

IMAGE="${1:?usage: boot-web-image.sh <image>}"
NAME="easyconvert-boot-check-$$"
PORT="${BOOT_CHECK_PORT:-39$((RANDOM % 900 + 100))}"
ATTEMPTS="${BOOT_CHECK_ATTEMPTS:-60}"
SECCOMP="$(cd "$(dirname "$0")/.." && pwd)/docker/seccomp-worker.json"

secret() { openssl rand -hex 32; }

cleanup() { docker rm -f "$NAME" > /dev/null 2>&1 || true; }
trap cleanup EXIT

docker run --detach --name "$NAME" \
  --read-only \
  --cap-drop ALL \
  --user 10001:10001 \
  --security-opt no-new-privileges:true \
  --security-opt "seccomp=$SECCOMP" \
  --tmpfs /tmp:size=256m,noexec,nosuid,nodev,uid=10001,gid=10001,mode=0750 \
  --tmpfs /home/easyconvert:size=512m,noexec,nosuid,nodev,uid=10001,gid=10001,mode=0750 \
  --tmpfs /app/.next/cache:size=128m,noexec,nosuid,nodev,uid=10001,gid=10001,mode=0750 \
  --tmpfs /shared/storage:size=64m,noexec,nosuid,nodev,uid=10001,gid=10001,mode=0750 \
  --publish "127.0.0.1:$PORT:3000" \
  --env NODE_ENV=production \
  --env APP_URL=http://127.0.0.1:3000 \
  --env STORAGE_DRIVER=local \
  --env EASYCONVERT_STORAGE_DIR=/shared/storage \
  --env STRICT_SANDBOX=true \
  --env "JWT_SECRET=$(secret)" \
  --env "KEY_HASH_PEPPER=$(secret)" \
  --env "WEBHOOK_SECRET_KEK=$(secret)" \
  --env "STORAGE_SIGNING_SECRET=$(secret)" \
  --env "JOB_SECRET_KEK=$(secret)" \
  "$IMAGE" > /dev/null

for ((attempt = 1; attempt <= ATTEMPTS; attempt++)); do
  if [ "$(docker inspect --format '{{.State.Running}}' "$NAME")" != true ]; then
    echo "boot check: the web server exited before it answered (exit code $(docker inspect --format '{{.State.ExitCode}}' "$NAME"))" >&2
    docker logs --tail 40 "$NAME" >&2
    exit 1
  fi
  status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/" || true)"
  if [ "$status" = 200 ]; then
    echo "boot check: the home page answered 200 after $attempt attempt(s)"
    exit 0
  fi
  sleep 2
done

echo "boot check: the home page did not answer 200 within $ATTEMPTS attempts (last status $status)" >&2
docker logs --tail 40 "$NAME" >&2
exit 1
