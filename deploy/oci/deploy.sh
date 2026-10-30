#!/usr/bin/env bash
# Deploys, rolls back and tends the EasyConvert stack on the shared OCI host (docs/deploy-oci.md). It runs on the self-hosted runner
# labelled easyconvert-production, as the unprivileged runner user, and touches only $EASYCONVERT_HOME (default /opt/easyconvert),
# the EasyConvert containers and images, and the scratch mount. It never runs a prune that reaches images or containers it did not
# create, and it never touches the other service's paths, nginx site or cluster.
#
#   deploy.sh filter-env  < raw-env            keep only the keys of deploy/oci/env-allowlist.txt (names of dropped keys go to stderr)
#   deploy.sh budget                           print the per-service limits derived from the two budget knobs
#   deploy.sh guard                            exit 1 and log a warning when the scratch mount is missing or a disk is nearly full
#   deploy.sh sweep                            delete scratch temp files older than two hours, from inside the worker image
#   deploy.sh deploy <image-ref>               pull, pin by digest, start, check health and one conversion, roll back on failure,
#                                              prune old images (<image-ref> is main or sha-<40 hex characters>)
#   deploy.sh rollback                         start the previous release again
set -euo pipefail

HOME_DIR="${EASYCONVERT_HOME:-/opt/easyconvert}"
WORKER_REPO="${WORKER_REPO:-ghcr.io/aquilaxk/easyconvert-worker}"
WEB_REPO="${WEB_REPO:-ghcr.io/aquilaxk/easyconvert-web}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8090/api/health}"
SMOKE_URL="${SMOKE_URL:-http://127.0.0.1:8090/api/convert}"
DATA_ROOT="${DATA_ROOT:-/var/lib/easysubway-data}"
MIN_FREE_GB="${MIN_FREE_GB:-15}"
SCRATCH_WARN_PERCENT="${SCRATCH_WARN_PERCENT:-85}"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-30}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-5}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALLOWLIST="${ENV_ALLOWLIST:-$SCRIPT_DIR/env-allowlist.txt}"
KEEP_RELEASES=2
IMAGE_REF_PATTERN='^(main|sha-[0-9a-f]{40})$'
ENV_KEY_PATTERN='^[A-Z_][A-Z0-9_]*$'
BASE_IMAGE_LABEL='org.opencontainers.image.base.name'
PNG_SIGNATURE='89504e470d0a1a0a'

log() { printf '[deploy] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# Keys of the allowlist, one per line. A line of the raw env that is not KEY=VALUE for one of them is dropped. The job log is public, so
# a dropped line is named by its key only when the key has the shape of a variable name, and otherwise by its line number: a line
# without a valid key may be a secret value that a line break split off.
filter_env() {
  local line key number=0
  while IFS= read -r line || [ -n "$line" ]; do
    number=$((number + 1))
    line="${line%$'\r'}"
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"
    if [ "$key" = "$line" ] || ! [[ "$key" =~ $ENV_KEY_PATTERN ]]; then
      log "dropped a line of the env secret: line $number is not KEY=VALUE"
    elif grep -Fxq -- "$key" "$ALLOWLIST"; then
      printf '%s\n' "$line"
    else
      log "dropped a line of the env secret: key '$key' is not in the allowlist"
    fi
  done
}

env_value() { # env_value <file> <key>
  grep -E "^$2=" "$1" | tail -n 1 | cut -d= -f2- || true
}

# One knob, two numbers: EASYCONVERT_BUDGET_CPUS and EASYCONVERT_BUDGET_MEMORY_GB (the whole stack). The shares follow the launch
# split of 3.5 cpus and 20 GiB: Redis 0.2 cpu and 0.5 GiB, the web 23% of the cpus and 27.5% of the memory, the worker the rest. The
# worker runs one job per 3.4 GiB (the share docker-compose.yml gives each of 3 jobs in 10 GiB, the figure the input limits of
# src/lib/conversions are sized for) and at most two jobs per cpu.
budget() { # budget <cpus> <memory GiB>, empty for the launch default
  local cpus="${1:-3.5}" mem_gib="${2:-20}"
  awk -v c="$cpus" -v m="$mem_gib" 'BEGIN {
    if (c !~ /^[0-9]+(\.[0-9]+)?$/ || m !~ /^[0-9]+(\.[0-9]+)?$/ || c < 1.5 || m < 6) { print "budget needs at least 1.5 cpus and 6 GiB" > "/dev/stderr"; exit 1 }
    redis_cpu = 0.2; web_cpu = int(c * 0.23 * 10 + 0.5) / 10; if (web_cpu < 0.5) web_cpu = 0.5
    worker_cpu = int((c - redis_cpu - web_cpu) * 10 + 0.5) / 10
    total_mib = int(m * 1024); redis_mib = 512; web_mib = int(m * 1024 * 0.275); worker_mib = total_mib - redis_mib - web_mib
    jobs = int(worker_mib / 1024 / 3.4); cap = int(worker_cpu * 2 + 0.999); if (cap < jobs) jobs = cap; if (jobs < 1) jobs = 1
    printf "EASYCONVERT_REDIS_CPUS=%.1f\nEASYCONVERT_WEB_CPUS=%.1f\nEASYCONVERT_WEB_MEMORY=%dm\n", redis_cpu, web_cpu, web_mib
    printf "EASYCONVERT_WORKER_CPUS=%.1f\nEASYCONVERT_WORKER_MEMORY=%dm\nEASYCONVERT_WORKER_CONCURRENCY=%d\n", worker_cpu, worker_mib, jobs
  }'
}

scratch_dir() {
  local dir="${1:-}"
  [ -n "$dir" ] || die "EASYCONVERT_SCRATCH_DIR is not set in the env secret"
  printf '%s' "$dir"
}

avail_gib() { df --output=avail -B1G "$1" | tail -n 1 | tr -d ' '; }
used_percent() { df --output=pcent "$1" | tail -n 1 | tr -d ' %'; }

# The scratch directory must be its own mounted file system: an unmounted directory would fill the shared data volume with no cap.
guard() {
  local env_file="${1:-$HOME_DIR/current/.env}" scratch free used
  scratch="$(scratch_dir "$(env_value "$env_file" EASYCONVERT_SCRATCH_DIR)")"
  mountpoint -q "$scratch" || die "$scratch is not a mount point: refusing to run without the capped scratch file system"
  free="$(avail_gib "$DATA_ROOT")"
  [ "$free" -ge "$MIN_FREE_GB" ] || die "only ${free} GiB free under $DATA_ROOT (minimum $MIN_FREE_GB GiB)"
  used="$(used_percent "$scratch")"
  if [ "$used" -ge "$SCRATCH_WARN_PERCENT" ]; then
    log "WARNING: scratch is ${used}% full"
    command -v logger > /dev/null && logger -t easyconvert "scratch is ${used}% full"
  fi
  log "guard ok: data volume ${free} GiB free, scratch ${used}% used"
}

compose() { # compose <release-dir> <args...>
  local dir="$1"; shift
  local profiles=()
  if ! grep -q '^REDIS_URL=' "$dir/.env"; then profiles+=(--profile redis); fi
  docker compose --project-name easyconvert --project-directory "$dir" --env-file "$dir/.env" \
    -f "$dir/docker-compose.prod.yml" "${profiles[@]}" "$@"
}

pin() { # pin <repo> <ref>: pull and print repo@digest
  local repo="$1" ref="$2" digest
  docker pull --quiet "$repo:$ref" > /dev/null || die "cannot pull $repo:$ref"
  digest="$(docker image inspect --format '{{index .RepoDigests 0}}' "$repo:$ref")"
  case "$digest" in "$repo@sha256:"*) printf '%s' "$digest" ;; *) die "no digest for $repo:$ref" ;; esac
}

# The web image names the worker image it was built on (Dockerfile.web). A tag that moved for one image and not yet for the other
# would pair a new worker with an old web; the pair is refused before anything starts.
check_pair() { # check_pair <ref> <worker repo@digest>
  local ref="$1" worker="$2" base
  base="$(docker image inspect --format "{{ index .Config.Labels \"$BASE_IMAGE_LABEL\" }}" "$WEB_REPO:$ref" 2> /dev/null || true)"
  [ "$base" = "$worker" ] || die "the web image of $ref was built on '${base:-no recorded image}', not on $worker"
}

healthy() {
  local remaining="$HEALTH_ATTEMPTS"
  while [ "$remaining" -gt 0 ]; do
    if curl --fail --silent --max-time 8 "$HEALTH_URL" > /dev/null; then return 0; fi
    remaining=$((remaining - 1))
    sleep "$HEALTH_INTERVAL"
  done
  return 1
}

# One conversion through the web service: a 1x1 PPM, which ImageMagick decodes in a sandboxed child (`unshare -r -n`), to PNG.
# /api/health starts no child, so this is the check that the host lets the sandbox run (AppArmor profile, seccomp profile).
smoke_conversion() {
  local dir status=1
  dir="$(mktemp -d)"
  printf 'P6\n1 1\n255\n\377\000\000' > "$dir/smoke.ppm"
  if curl --fail --silent --show-error --max-time 60 -o "$dir/smoke.png" \
    -F "file=@$dir/smoke.ppm;filename=smoke.ppm" -F targetFormat=png "$SMOKE_URL" \
    && [ "$(head -c 8 "$dir/smoke.png" | od -An -tx1 | tr -d ' \n')" = "$PNG_SIGNATURE" ]; then
    status=0
  else
    log "the smoke conversion (PPM to PNG through $SMOKE_URL) failed"
  fi
  rm -rf -- "$dir"
  return "$status"
}

start_release() { # start_release <release-dir>
  compose "$1" up -d --wait --wait-timeout 240 --remove-orphans && healthy && smoke_conversion
}

# A cancelled job (the runner sends SIGINT, then SIGTERM, then kills it seconds later) starts the previous release again without
# waiting for it, so the stack is not left on a release that never passed its checks.
cancelled() { # cancelled <release-dir> <previous-dir>
  local release="$1" previous="$2"
  log "cancelled: starting the previous release again"
  if [ -n "$previous" ] && [ -d "$previous" ]; then
    compose "$previous" up -d --remove-orphans || log "could not start $previous"
  elif [ -f "$release/.env" ]; then
    compose "$release" down || true
  fi
  rm -rf -- "$release"
  exit 130
}

# Removes the EasyConvert images that neither the current nor the previous release names. Only images of the two repositories are
# considered, so another service's images are never touched.
prune_images() {
  local keep repo digest id
  keep="$(cat "$HOME_DIR"/current/images.env "$HOME_DIR"/previous/images.env 2> /dev/null || true)"
  for repo in "$WORKER_REPO" "$WEB_REPO"; do
    docker image ls --digests --no-trunc --format '{{.Repository}} {{.Digest}} {{.ID}}' "$repo" | while read -r name digest id; do
      [ "$name" = "$repo" ] || continue
      if ! printf '%s\n' "$keep" | grep -Fq "$repo@$digest"; then
        log "removing unused image $repo@$digest"
        docker image rm "$id" > /dev/null 2>&1 || log "kept $id (still in use)"
      fi
    done
  done
}

prune_releases() {
  local dir
  # shellcheck disable=SC2012
  ls -1dt "$HOME_DIR"/releases/*/ 2> /dev/null | tail -n +$((KEEP_RELEASES + 1)) | while read -r dir; do
    [ "$(readlink -f "$dir")" = "$(readlink -f "$HOME_DIR/current")" ] && continue
    [ "$(readlink -f "$dir")" = "$(readlink -f "$HOME_DIR/previous")" ] && continue
    log "removing old release $dir"
    rm -rf -- "$dir"
  done
}

deploy() {
  local ref="${1:-}" source_dir="${SOURCE_DIR:?SOURCE_DIR (the checkout)}" raw_env="${ENV_FILE:?ENV_FILE (the filtered env)}"
  local release worker web previous budget_env
  [[ "$ref" =~ $IMAGE_REF_PATTERN ]] || die "the image ref must be main or sha-<40 hex characters>"
  guard "$raw_env"
  budget_env="$(budget "$(env_value "$raw_env" EASYCONVERT_BUDGET_CPUS)" "$(env_value "$raw_env" EASYCONVERT_BUDGET_MEMORY_GB)")" \
    || die "the budget in the env secret cannot be used"

  worker="$(pin "$WORKER_REPO" "$ref")"
  web="$(pin "$WEB_REPO" "$ref")"
  check_pair "$ref" "$worker"
  previous="$(readlink -f "$HOME_DIR/current" 2> /dev/null || true)"
  release="$HOME_DIR/releases/$(date -u +%Y%m%dT%H%M%SZ)-$ref"
  trap 'cancelled "$release" "$previous"' INT TERM
  mkdir -p "$release/docker" "$HOME_DIR/bin"
  cp "$SCRIPT_DIR/deploy.sh" "$SCRIPT_DIR/env-allowlist.txt" "$HOME_DIR/bin/"
  cp "$source_dir/docker-compose.prod.yml" "$release/"
  cp "$source_dir/docker/seccomp-worker.json" "$release/docker/"
  printf 'EASYCONVERT_WORKER_IMAGE=%s\nEASYCONVERT_WEB_IMAGE=%s\n' "$worker" "$web" > "$release/images.env"

  (
    umask 077
    cat "$raw_env" > "$release/.env"
    local line key
    while IFS= read -r line; do
      key="${line%%=*}"
      grep -q "^$key=" "$raw_env" || printf '%s\n' "$line" >> "$release/.env"
    done <<< "$budget_env"
    cat "$release/images.env" >> "$release/.env"
  )
  chmod 600 "$release/.env"

  compose "$release" config --quiet || die "the compose file does not accept this env secret"
  compose "$release" run --rm --no-deps --entrypoint sh worker -c 'find /tmp -mindepth 1 -mmin +120 -delete' || log "scratch sweep skipped"

  if start_release "$release"; then
    trap - INT TERM
    [ -z "$previous" ] || ln -sfn "$previous" "$HOME_DIR/previous"
    ln -sfn "$release" "$HOME_DIR/current"
    prune_releases
    prune_images
    log "deployed $worker and $web"
    return 0
  fi

  log "the new release failed its checks: rolling back"
  compose "$release" logs --no-color --tail 80 web worker >&2 || true
  if [ -n "$previous" ] && [ -d "$previous" ]; then
    start_release "$previous" || die "rollback to $previous also failed"
    log "rolled back to $(basename "$previous")"
  else
    compose "$release" down || true
    log "no previous release to roll back to; the stack is stopped"
  fi
  trap - INT TERM
  rm -rf -- "$release"
  return 1
}

rollback() {
  local previous current
  previous="$(readlink -f "$HOME_DIR/previous" 2> /dev/null || true)"
  [ -n "$previous" ] && [ -d "$previous" ] || die "there is no previous release"
  current="$(readlink -f "$HOME_DIR/current")"
  start_release "$previous" || die "the previous release did not become healthy"
  ln -sfn "$current" "$HOME_DIR/previous"
  ln -sfn "$previous" "$HOME_DIR/current"
  log "now running $(basename "$previous")"
}

sweep() {
  compose "$HOME_DIR/current" run --rm --no-deps --entrypoint sh worker -c 'find /tmp -mindepth 1 -mmin +120 -delete'
}

case "${1:-}" in
  filter-env) filter_env ;;
  budget) budget "${EASYCONVERT_BUDGET_CPUS:-3.5}" "${EASYCONVERT_BUDGET_MEMORY_GB:-20}" ;;
  guard) guard "${2:-$HOME_DIR/current/.env}" ;;
  sweep) sweep ;;
  deploy) deploy "${2:-}" ;;
  rollback) rollback ;;
  *) die "usage: deploy.sh filter-env | budget | guard | sweep | deploy <image-ref> | rollback" ;;
esac
