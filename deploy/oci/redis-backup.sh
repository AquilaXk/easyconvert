#!/usr/bin/env bash
# Takes a consistent snapshot of the Redis of the production stack, keeps it on the host and removes the ones that are too many or too
# old (docs/operations/backup-and-restore.md). It runs from the systemd timer in deploy/oci/easyconvert-redis-backup.timer, as the
# user easyconvert-deploy, and can be run by hand the same way.
#
#   redis-backup.sh            back up now, then prune
#   redis-backup.sh prune      only prune (by age, then by number)
#
# How the snapshot is taken (Redis 7.4 persistence documentation, "Backing up Redis data"): BGSAVE writes /data/dump.rdb from a fork, so
# the file is a point-in-time image of the data set and is replaced by a rename, never written in place; the stack runs with
# `--save ""`, so only this script writes it. The script waits for the save to finish, checks the file inside the container
# (redis-check-rdb, which verifies the checksum the RDB format ends with), copies it out with `cat` and compares the SHA-256 of the
# copy with the one computed in the container. The password never leaves the container: redis-cli reads it from the container's own
# REDIS_PASSWORD through REDISCLI_AUTH, so it is on no command line of the host and in no output of this script.
#
# A backup is the file redis-<UTC time>.rdb and its checksum file redis-<UTC time>.rdb.sha256 (the format `sha256sum -c` reads), both
# mode 0600 in a directory of mode 0700. It is a copy of every account, API key hash and queued job, so it is as sensitive as the Redis
# volume itself. Files older than BACKUP_MAX_AGE_DAYS go first and then all but the newest BACKUP_KEEP: the age is what keeps the
# promise to delete an account within 10 days (policy entry 186), the number only bounds the disk.
set -euo pipefail

HOME_DIR="${EASYCONVERT_HOME:-/opt/easyconvert}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/easysubway-data/easyconvert/redis-backups}"
BACKUP_KEEP="${BACKUP_KEEP:-28}"
BACKUP_MAX_AGE_DAYS="${BACKUP_MAX_AGE_DAYS:-7}"
BACKUP_WAIT_SECONDS="${BACKUP_WAIT_SECONDS:-120}"
BACKUP_POLL_SECONDS="${BACKUP_POLL_SECONDS:-1}"
BACKUP_MIN_FREE_MB="${BACKUP_MIN_FREE_MB:-1024}"
REDIS_RDB_PATH="${REDIS_RDB_PATH:-/data/dump.rdb}"
RDB_MAGIC='REDIS'

PART_FILE=""

log() { printf '[redis-backup] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

cleanup() {
  [ -z "$PART_FILE" ] || rm -f -- "$PART_FILE"
}

is_count() { case "$1" in '' | *[!0-9]*) return 1 ;; *) return 0 ;; esac; }

sha256_of() { # sha256_of <file>: the hex digest
  if command -v sha256sum > /dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# The compose invocation of deploy.sh: the project, the env file and the compose file of the running release.
compose() {
  local dir="$HOME_DIR/current"
  docker compose --project-name easyconvert --project-directory "$dir" --env-file "$dir/.env" \
    -f "$dir/docker-compose.prod.yml" --profile redis "$@"
}

# redis-cli inside the Redis container, authenticated with the container's own password.
rcli() {
  # shellcheck disable=SC2016  # the container's shell expands $REDIS_PASSWORD, not this one
  compose exec -T redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" exec redis-cli "$@"' redis-cli "$@"
}

info_field() { # info_field <name>: a field of INFO persistence
  rcli INFO persistence | tr -d '\r' | sed -n "s/^$1://p" | head -n 1
}

# The backups pruning may remove are exactly the names this script writes. The UTC time in a name sorts as time.
backup_files() { # prints the .rdb files, oldest first
  local file
  for file in "$BACKUP_DIR"/redis-????????T??????Z.rdb; do
    if [ -f "$file" ]; then printf '%s\n' "$file"; fi
  done
}

remove_backup() { rm -f -- "$1" "$1.sha256"; }

prune_by_age() {
  local file
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    remove_backup "$file"
    log "removed $(basename "$file") (older than $BACKUP_MAX_AGE_DAYS days)"
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'redis-????????T??????Z.rdb' -mmin +$((BACKUP_MAX_AGE_DAYS * 1440)))
  # What a crashed run left: an unfinished copy, and a checksum file whose backup is gone.
  rm -f -- "$BACKUP_DIR"/.redis-*.part
  for file in "$BACKUP_DIR"/redis-????????T??????Z.rdb.sha256; do
    if [ -f "$file" ] && [ ! -f "${file%.sha256}" ]; then rm -f -- "$file"; fi
  done
}

prune_by_count() {
  local files total excess file
  files="$(backup_files)"
  [ -n "$files" ] || return 0
  total="$(printf '%s\n' "$files" | wc -l | tr -d ' ')"
  [ "$total" -gt "$BACKUP_KEEP" ] || return 0
  excess=$((total - BACKUP_KEEP))
  while IFS= read -r file; do
    remove_backup "$file"
    log "removed $(basename "$file") (more than $BACKUP_KEEP kept)"
  done < <(printf '%s\n' "$files" | head -n "$excess")
}

wait_for_save() { # wait_for_save <rdb_saves before the request>
  local before="$1" waited=0 in_progress saves status
  while :; do
    in_progress="$(info_field rdb_bgsave_in_progress)"
    saves="$(info_field rdb_saves)"
    status="$(info_field rdb_last_bgsave_status)"
    if [ "$in_progress" = 0 ] && is_count "$saves" && [ "$saves" -gt "$before" ]; then
      [ "$status" = ok ] || die "the background save failed (rdb_last_bgsave_status:$status)"
      return 0
    fi
    [ "$waited" -lt "$BACKUP_WAIT_SECONDS" ] || die "the background save did not finish within $BACKUP_WAIT_SECONDS seconds"
    sleep "$BACKUP_POLL_SECONDS"
    waited=$((waited + BACKUP_POLL_SECONDS))
  done
}

snapshot() {
  local before reply stamp final inside_sum copy_sum size free_mb
  [ -f "$HOME_DIR/current/.env" ] || die "no running release: $HOME_DIR/current/.env is missing"
  if grep -q '^REDIS_URL=' "$HOME_DIR/current/.env"; then
    die "this stack uses another Redis (REDIS_URL is set); back that one up where it runs"
  fi
  [ -n "$(compose ps -q redis)" ] || die "the redis container is not running"

  free_mb="$(df -Pm "$BACKUP_DIR" | awk 'NR == 2 { print $4 }')"
  if ! is_count "$free_mb" || [ "$free_mb" -lt "$BACKUP_MIN_FREE_MB" ]; then die "less than $BACKUP_MIN_FREE_MB MB free under $BACKUP_DIR"; fi

  before="$(info_field rdb_saves)"
  is_count "$before" || die "cannot read rdb_saves from Redis (is it up, and is REDIS_PASSWORD right?)"
  reply="$(rcli BGSAVE | tr -d '\r')"
  case "$reply" in
    'Background saving started' | 'Background saving scheduled') ;;
    *'already in progress'*) log "a save was already running; waiting for it" ;;
    *) die "BGSAVE was refused: $reply" ;;
  esac
  wait_for_save "$before"

  compose exec -T redis redis-check-rdb "$REDIS_RDB_PATH" > /dev/null || die "redis-check-rdb rejected $REDIS_RDB_PATH"
  inside_sum="$(compose exec -T redis sha256sum "$REDIS_RDB_PATH" | cut -d' ' -f1)"
  [ "${#inside_sum}" -eq 64 ] || die "cannot read the checksum of $REDIS_RDB_PATH"

  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  final="$BACKUP_DIR/redis-$stamp.rdb"
  [ ! -e "$final" ] || die "$final exists already"
  PART_FILE="$BACKUP_DIR/.redis-$stamp.part"
  compose exec -T redis cat "$REDIS_RDB_PATH" > "$PART_FILE"
  size="$(wc -c < "$PART_FILE" | tr -d ' ')"
  [ "$size" -gt 0 ] || die "the copy is empty"
  [ "$(head -c ${#RDB_MAGIC} "$PART_FILE")" = "$RDB_MAGIC" ] || die "the copy does not start with $RDB_MAGIC"
  copy_sum="$(sha256_of "$PART_FILE")"
  [ "$copy_sum" = "$inside_sum" ] || die "the copy differs from the file in the container (another save ran meanwhile?); run again"

  printf '%s  %s\n' "$copy_sum" "redis-$stamp.rdb" > "$final.sha256"
  mv -- "$PART_FILE" "$final"
  PART_FILE=""
  log "backup ok: $final, $size bytes, sha256 $copy_sum"
  printf '%s\n' "$final"
}

main() {
  local action="${1:-backup}"
  case "$action" in backup | prune) ;; *) die "usage: redis-backup.sh [backup|prune]" ;; esac
  if ! is_count "$BACKUP_KEEP" || [ "$BACKUP_KEEP" -lt 1 ]; then die "BACKUP_KEEP must be a number of 1 or more"; fi
  if ! is_count "$BACKUP_MAX_AGE_DAYS" || [ "$BACKUP_MAX_AGE_DAYS" -lt 1 ]; then die "BACKUP_MAX_AGE_DAYS must be a number of 1 or more"; fi
  if ! is_count "$BACKUP_WAIT_SECONDS" || ! is_count "$BACKUP_POLL_SECONDS" || [ "$BACKUP_POLL_SECONDS" -lt 1 ]; then
    die "BACKUP_WAIT_SECONDS must be a number and BACKUP_POLL_SECONDS a number of 1 or more"
  fi

  umask 077
  mkdir -p -- "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"

  # One run at a time, by flock(1) on a lock file: the kernel drops the lock when the process ends, however it ends, so a killed run or
  # a reboot cannot leave a lock that blocks the later runs (and their pruning). The file itself stays and is empty.
  trap cleanup EXIT
  exec 9> "$BACKUP_DIR/.lock" || die "cannot open $BACKUP_DIR/.lock"
  flock -n 9 || die "another run holds $BACKUP_DIR/.lock"

  # The age comes first and does not depend on the backup succeeding: a backup that cannot be taken must still not keep old copies.
  prune_by_age
  if [ "$action" = backup ]; then snapshot; fi
  prune_by_count
}

main "$@"
