#!/usr/bin/env bash
# The restore drill of docs/operations/backup-and-restore.md, for a machine that has the Redis binaries but no Docker (the Linux test VM).
# It never touches the production host: everything lives in the empty work directory it is given, on a loopback port, and the only
# processes it starts are two redis-server instances that it stops by their process ids.
#
#   REDIS_BIN_DIR=<directory with redis-server, redis-cli, redis-check-rdb>  redis-restore-drill.sh <empty work directory>
#
# 1. starts a Redis with the flags of redis in docker-compose.prod.yml (password, maxmemory, noeviction, append-only file, no RDB save);
# 2. loads sample accounts, API keys, a queue, sessions with an expiry;
# 3. takes a backup with the real deploy/oci/redis-backup.sh, through a stand-in for `docker compose exec` that runs the same commands
#    against this instance (it is the only difference from the host: the container plumbing);
# 4. destroys the instance and its data directory (kill -9, then the directory is removed);
# 5. restores as the runbook says: put the dump into an empty data directory, load it in a throwaway server with the append-only file
#    off, switch the file on (CONFIG SET appendonly yes, which rewrites it from memory), stop it, start the real flags again;
# 6. checks the key count, the key types, sample values and an expiry against what step 2 recorded, and once more after a restart,
#    which proves the restored data is in the append-only file and not only in memory.
set -euo pipefail

BIN="${REDIS_BIN_DIR:?set REDIS_BIN_DIR to the directory of redis-server, redis-cli and redis-check-rdb}"
KEYS="${DRILL_KEYS:-50000}"
PORT="${DRILL_PORT:-6391}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '[drill] %s\n' "$*"; }
die() { printf '[drill] ERROR: %s\n' "$*" >&2; exit 1; }

[ -n "${1:-}" ] || die "usage: redis-restore-drill.sh <empty work directory>"
mkdir -p -- "$1"
W="$(cd "$1" && pwd)"
[ -z "$(ls -A "$W")" ] || die "$W is not empty"
for tool in redis-server redis-cli redis-check-rdb; do [ -x "$BIN/$tool" ] || die "$BIN/$tool is missing"; done
if [ -n "$("$BIN/redis-cli" -p "$PORT" ping 2> /dev/null || true)" ]; then die "something already answers on port $PORT"; fi

mkdir -p "$W/data" "$W/shim" "$W/home/current"
PASSWORD="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
export REDISCLI_AUTH="$PASSWORD"
SERVER_PID=""

now_ms() { if [ -n "${EPOCHREALTIME:-}" ]; then local t="${EPOCHREALTIME/./}"; echo $((t / 1000)); else echo $(($(date +%s) * 1000)); fi; }
NOAUTH=""
cli() { if [ -n "$NOAUTH" ]; then env -u REDISCLI_AUTH "$BIN/redis-cli" -p "$PORT" "$@"; else "$BIN/redis-cli" -p "$PORT" "$@"; fi; }
stop_server() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2> /dev/null; then kill "$SERVER_PID" 2> /dev/null || true; wait "$SERVER_PID" 2> /dev/null || true; fi
  SERVER_PID=""
}
trap stop_server EXIT

wait_ready() { # a server that is still loading answers LOADING, not PONG
  local tries=0
  until cli ping 2> /dev/null | grep -q PONG; do
    tries=$((tries + 1)); [ "$tries" -lt 600 ] || die "the server did not become ready"
    kill -0 "$SERVER_PID" 2> /dev/null || die "the server exited"
    sleep 0.1
  done
}

# The flags of the redis service in docker-compose.prod.yml, with the data directory and port of this drill.
start_production_flags() {
  "$BIN/redis-server" --port "$PORT" --bind 127.0.0.1 --dir "$W/data" --requirepass "$PASSWORD" --maxmemory 256mb \
    --maxmemory-policy noeviction --appendonly yes --appendfsync everysec --auto-aof-rewrite-percentage 100 \
    --auto-aof-rewrite-min-size 16mb --save "" --protected-mode yes > "$W/server.log" 2>&1 &
  SERVER_PID=$!
  wait_ready
}

# The throwaway server of the restore: no password, no network but this loopback port, no append-only file until the data is loaded.
start_loader() {
  "$BIN/redis-server" --port "$PORT" --bind 127.0.0.1 --dir "$W/data" --appendonly no --save "" --protected-mode no > "$W/loader.log" 2>&1 &
  SERVER_PID=$!
  NOAUTH=1 wait_ready
}

resp() { awk -v n="$KEYS" 'function cmd(a, k,  s, j) { s = "*" k "\r\n"; for (j = 1; j <= k; j++) s = s "$" length(a[j]) "\r\n" a[j] "\r\n"; printf "%s", s }
  BEGIN {
    for (i = 1; i <= n; i++) { a[1] = "SET"; a[2] = "user:" i; a[3] = "{\"email\":\"person" i "@example.test\",\"plan\":\"free\"}"; cmd(a, 3) }
    for (i = 1; i <= n / 10; i++) { a[1] = "HSET"; a[2] = "apikey:" i; a[3] = "hash"; a[4] = "h" i "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; a[5] = "plan"; a[6] = "free"; cmd(a, 6) }
    for (i = 1; i <= n / 10; i++) { a[1] = "ZADD"; a[2] = "queue:wait"; a[3] = i; a[4] = "job-" i; cmd(a, 4) }
    for (i = 1; i <= 50; i++) { a[1] = "SETEX"; a[2] = "session:" i; a[3] = "86400"; a[4] = "token-" i; cmd(a, 4) }
    a[1] = "RPUSH"; a[2] = "events"; a[3] = "one"; a[4] = "two"; a[5] = "three"; cmd(a, 5)
  }'; }

snapshot_state() { # snapshot_state <file>: what the verification compares
  {
    echo "dbsize $(cli dbsize)"
    echo "user:1 $(cli get user:1)"
    echo "user:$KEYS $(cli get "user:$KEYS")"
    echo "apikey:7 $(cli hgetall apikey:7 | tr '\n' ' ')"
    echo "queue:wait $(cli zcard queue:wait) $(cli zscore queue:wait job-3)"
    echo "events $(cli lrange events 0 -1 | tr '\n' ' ')"
    echo "type:session:5 $(cli type session:5)"
    echo "ttl:session:5 $([ "$(cli ttl session:5)" -gt 0 ] && echo set || echo missing)"
  } > "$1"
}

verify_state() { # verify_state <label>
  snapshot_state "$W/after-$1.txt"
  if diff -u "$W/before.txt" "$W/after-$1.txt" > "$W/diff-$1.txt"; then log "verified ($1): $(head -n 1 "$W/after-$1.txt"), sample values and expiry equal"; else cat "$W/diff-$1.txt"; die "the data after $1 differs from the data before"; fi
}

# --- the stand-in for `docker compose ... exec -T redis <command>` and `ps -q redis` -----------------------------------------------
cat > "$W/shim/redis-cli" << EOF
#!/usr/bin/env bash
exec "$BIN/redis-cli" -p "$PORT" "\$@"
EOF
cat > "$W/shim/docker" << 'EOF'
#!/usr/bin/env bash
# Maps the container's /data to the drill's data directory and runs the command on the host. REDIS_PASSWORD is set only here, as it is
# set in the container's environment: the backup script never sees it.
args=("$@")
for i in "${!args[@]}"; do
  [ "${args[$i]}" = "exec" ] && exec_at=$i
  [ "${args[$i]}" = "ps" ] && ps_at=$i
done
if [ -n "${ps_at:-}" ]; then echo drill-container; exit 0; fi
rest=("${args[@]:$((exec_at + 3))}")
case "${rest[0]}" in
  sh) unset REDISCLI_AUTH; export REDIS_PASSWORD="$DRILL_PASSWORD" PATH="$DRILL_SHIM:$PATH"; exec "${rest[@]}" ;;
  redis-check-rdb) exec "$DRILL_BIN/redis-check-rdb" "${rest[1]/#\/data/$DRILL_DATA}" ;;
  sha256sum) f="${rest[1]/#\/data/$DRILL_DATA}"; sum="$( (sha256sum "$f" 2> /dev/null || shasum -a 256 "$f") | cut -d' ' -f1)"; printf '%s  %s\n' "$sum" "${rest[1]}" ;;
  cat) exec cat "${rest[1]/#\/data/$DRILL_DATA}" ;;
  *) echo "drill stand-in: unexpected command ${rest[*]}" >&2; exit 2 ;;
esac
EOF
chmod 755 "$W/shim/docker" "$W/shim/redis-cli"
printf 'APP_URL=https://convert.example.test\nREDIS_PASSWORD=%s\n' "$PASSWORD" > "$W/home/current/.env"
chmod 600 "$W/home/current/.env"

# --- 1 and 2: the instance and its data -------------------------------------------------------------------------------------------
log "redis-server $("$BIN/redis-server" --version | sed -E 's/.*v=([0-9.]+).*/\1/') on port $PORT, $KEYS sample accounts"
start_production_flags
t0="$(now_ms)"
resp | cli --pipe > "$W/load.log"
cli config get appendonly | tr '\n' ' ' | grep -q 'appendonly yes' || die "the append-only file is not on"
snapshot_state "$W/before.txt"
log "loaded in $(($(now_ms) - t0)) ms: $(head -n 1 "$W/before.txt"), memory $(cli info memory | tr -d '\r' | sed -n 's/^used_memory_human://p')"

# --- 3: the backup, by the real script ----------------------------------------------------------------------------------------------
t0="$(now_ms)"
backup="$(PATH="$W/shim:$PATH" DRILL_PASSWORD="$PASSWORD" DRILL_SHIM="$W/shim" DRILL_BIN="$BIN" DRILL_DATA="$W/data" \
  EASYCONVERT_HOME="$W/home" BACKUP_DIR="$W/backups" BACKUP_MIN_FREE_MB=0 bash "$HERE/redis-backup.sh")" || die "redis-backup.sh failed"
log "backup in $(($(now_ms) - t0)) ms: $(basename "$backup"), $(wc -c < "$backup" | tr -d ' ') bytes"
grep -q "$PASSWORD" "$W/backups"/*.sha256 && die "the password is in a backup file's checksum file"

# --- 4: the disaster ----------------------------------------------------------------------------------------------------------------
kill -9 "$SERVER_PID"; wait "$SERVER_PID" 2> /dev/null || true; SERVER_PID=""
rm -rf -- "$W/data"
mkdir "$W/data"
log "instance killed and data directory wiped: $(find "$W/data" -type f | wc -l | tr -d ' ') files left"

# --- 5: the restore (this is the timed part: from the verified backup to a server that answers with the data) ----------------------
restore_start="$(now_ms)"
(cd "$W/backups" && if command -v sha256sum > /dev/null; then sha256sum -c "$(basename "$backup").sha256"; else shasum -a 256 -c "$(basename "$backup").sha256"; fi) > /dev/null || die "the backup does not match its checksum"
cp -- "$backup" "$W/data/dump.rdb"
start_loader
loaded="$(NOAUTH=1 cli dbsize)"
log "loaded the dump into the throwaway server: $loaded keys"
NOAUTH=1 cli config set appendonly yes > /dev/null
tries=0
while :; do
  persistence="$(NOAUTH=1 cli info persistence | tr -d '\r')"
  if printf '%s\n' "$persistence" | grep -q '^aof_rewrite_in_progress:0$' && printf '%s\n' "$persistence" | grep -q '^aof_rewrite_scheduled:0$'; then break; fi
  tries=$((tries + 1)); [ "$tries" -lt 600 ] || die "the append-only file was not written"
  sleep 0.1
done
printf '%s\n' "$persistence" | grep -q '^aof_last_bgrewrite_status:ok$' || die "the append-only rewrite failed"
NOAUTH=1 cli shutdown nosave > /dev/null 2>&1 || true
wait "$SERVER_PID" 2> /dev/null || true; SERVER_PID=""
rm -f -- "$W/data/dump.rdb"
[ -d "$W/data/appendonlydir" ] || die "no append-only directory was written"
start_production_flags
restore_ms=$(($(now_ms) - restore_start))
log "RESTORE TIME: $restore_ms ms from the checksum check to a server with the production flags that answers"

# --- 6: the checks -----------------------------------------------------------------------------------------------------------------
verify_state restore
cli shutdown nosave > /dev/null 2>&1 || true
wait "$SERVER_PID" 2> /dev/null || true; SERVER_PID=""
start_production_flags
verify_state restart
log "DRILL OK: $KEYS sample accounts, backup $(basename "$backup"), restore $restore_ms ms"
