# Redis backup and restore

Redis holds the accounts, API keys and their hashed secrets, the daily quota counters, the retention records and the job queue (`docker-compose.prod.yml`, service `redis`). It is the only state of the service that matters. This page is how it is kept, how it is copied, and how it comes back. The choices are policy entry 186.

## What is kept, and what is not

- **Persistence.** The append-only file (`appendonly yes`, `appendfsync everysec`) in the volume `easyconvert_redis-data`, mounted at `/data`. A restart or a crash loses at most about a second. `maxmemory` is 256 MB with `noeviction`: a full Redis refuses writes and never drops a queued job.
- **Files.** None. User files live on the scratch file system and are deleted minutes after delivery ([README](README.md#object-storage)). There is no object storage and no backup of files.
- **What a backup holds.** Every account (email address, plan), the hashes of the API keys, encrypted webhook secrets, quota counters, and the job records. The privacy policy says the operator makes no backup of files and results, and describes the record backups. A job sent through the API with the file inline (`inputBufferBase64`, at most 32 MiB) carries that file in its record until the job ends, so a backup taken at that moment holds it for as long as the backup lives (7 days). This is the residual that [entry 186](../policy-decisions.md#186-redis-is-backed-up-every-6-hours-to-the-hosts-data-volume-for-7-days-an-account-is-erased-within-2-days-and-the-status-of-the-service-is-the-uptime-workflows-public-run-history) records; the privacy policy states it (section 3, backup row) from version 2026-11-08.
- **What a backup needs to be useful.** The env secret `EASYCONVERT_ENV` (kept in the GitHub environment `easyconvert-production`). The key hashes are peppered with `KEY_HASH_PEPPER` and the webhook secrets sealed with `WEBHOOK_SECRET_KEK`: a restore under other values leaves every API key and webhook unusable.
- **What a backup does not protect against.** Loss of the data disk or of the instance: the copies are on the same volume (`/var/lib/easysubway-data`, which also holds Docker's root and the scratch file system). There is no cloud storage and no paid service. It does protect against a damaged append-only file, a bad deploy or Redis upgrade, a mistaken command and a removed volume. Do not copy a backup off the host: a copy outside the 7-day rule below is a copy the deletion promise does not reach.

## Schedule and retention

| | |
| --- | --- |
| Schedule | every 6 hours, 00:17, 06:17, 12:17 and 18:17 UTC (`deploy/oci/easyconvert-redis-backup.timer`; a run missed while the host was off is made up at the next start) |
| Where | `/var/lib/easysubway-data/easyconvert/redis-backups/`, mode 0700, files 0600 |
| Files | `redis-<UTC time>.rdb` and `redis-<UTC time>.rdb.sha256` (`sha256sum -c` reads it) |
| Kept | not older than **7 days**, and at most **28** (`BACKUP_MAX_AGE_DAYS`, `BACKUP_KEEP` of `deploy/oci/redis-backup.sh`). The age is checked first and on every run, also when the new backup fails |
| Size | about the size of the data in memory: a few megabytes at launch; at the worst, 256 MB each, 7 GiB for 28. The script stops when less than 1 GiB is free; a deploy stops at 15 GiB |
| Cost | none: the volume exists and nothing is added |

The script (`deploy/oci/redis-backup.sh`) takes the snapshot as the Redis documentation describes for backups: `BGSAVE` writes `/data/dump.rdb` from a fork, a point-in-time image replaced by a rename; the stack runs with `--save ""`, so only the script writes it. The script waits until the save ended (`rdb_saves` rose and no save is running), has `redis-check-rdb` verify the file in the container, copies it out with `docker compose exec -T redis cat`, compares its SHA-256 with the one computed in the container, and only then names it. The password is never on a command line or in an output: `redis-cli` reads `REDIS_PASSWORD` from the container's own environment.

### Install (once, on the host)

**Precondition: the privacy wording has landed** (QA 2026-11-08, [entry 186](../policy-decisions.md#186-redis-is-backed-up-every-6-hours-to-the-hosts-data-volume-for-7-days-an-account-is-erased-within-2-days-and-the-status-of-the-service-is-the-uptime-workflows-public-run-history)): the privacy policy (sections 3 and 4), the terms (section 3) and the data processing terms (section 7) describe the record backups, from version 2026-11-08. The terms promise 30 days' notice of a change unfavourable to users (terms section 9), and a backup that can hold an API job's file is one, so install the timer on or after 2026-12-08, and take no backup, by timer or by hand, before then.

From a checkout of this repository. Nothing here is installed by a deploy, and it was not installed when this page was written. The unit runs with `NoNewPrivileges`, a private `/tmp`, and a read-only file system except the backup directory (`ProtectSystem=strict`, `ReadWritePaths`); the directory must exist before the service starts, which the first command creates. That `docker compose exec` works under these settings is reasoned (it only connects to the Docker socket, which a read-only mount allows, and writes nothing) and was not tested on the host: after installing, run `sudo systemctl start easyconvert-redis-backup.service` and read `journalctl -u easyconvert-redis-backup.service`; if it fails on a read-only path, name the path in `ReadWritePaths`.

```
sudo install -d -o easyconvert-deploy -g easyconvert-deploy -m 0700 /var/lib/easysubway-data/easyconvert/redis-backups
sudo install -m 0755 deploy/oci/redis-backup.sh /opt/easyconvert/bin/redis-backup.sh
sudo install -m 0644 deploy/oci/easyconvert-redis-backup.service deploy/oci/easyconvert-redis-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now easyconvert-redis-backup.timer
sudo -u easyconvert-deploy /opt/easyconvert/bin/redis-backup.sh
```

The last line is the first backup, by hand. It prints the path of the file. Install the script again with the second command whenever `deploy/oci/redis-backup.sh` changes; a deploy does not copy it.

### Check it (weekly, and after any incident)

```
systemctl list-timers easyconvert-redis-backup.timer
journalctl -u easyconvert-redis-backup.service -n 20 --no-pager
ls -l --time-style=long-iso /var/lib/easysubway-data/easyconvert/redis-backups/ | tail -n 6
```

The newest `.rdb` must be less than 7 hours old. No alert watches this yet (alerts are phase 2 of #899); a failed run shows in `systemctl --failed`. If runs fail for 7 days, the age rule has removed every backup: fix the cause the same day.

## Account deletion and backups

The privacy policy promises that an account is deleted within 10 days of the request. A backup taken before the deletion still holds the account, so:

1. **Erase within 2 days of the request**, not 10: the steps in [Deleting an account](../deploy-oci.md#deleting-an-account). Then every backup that holds the account is at most 7 days old and has been removed by about 9 days 6 hours after the request (7 days, plus the 6 hours until the next run, which prunes, plus its random delay of up to 2 minutes), inside the promise with 18 hours to spare.
2. **Right after `--apply` succeeded, rewrite the append-only file**: `C exec -T redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli BGREWRITEAOF'` (shell function `C` in the [README](README.md#your-shell-on-the-host)). The file records the commands that created the account and then the ones that deleted it, and keeps both until the next rewrite, which at this size can be a long way off. The rewrite writes the data as it is now.
3. **Nothing else holds the account.** Old backups expire by themselves; do not edit one. There is no other copy.
4. **A restore brings deleted accounts back.** Step 8 of [Restore](#restore) erases again every account whose erasure finished after the backup's time, including a request that was still open when the backup was taken (a request made an hour before the backup and erased an hour after it is in the backup, and is caught by the time of the erasure, not of the request).
5. **Record when each erasure finished, so the restore can find it.** The record is the notice you send the requester (step 5 of [Deleting an account](../deploy-oci.md#deleting-an-account)): send it at once after `--apply` succeeded and the rewrite ran, from `support@aquilaxk.site`, with "deleted" in the subject. Its date is the completion time. It adds nothing: the mailbox already holds the request, and no list of erased accounts is kept on the host.

## Restore

When: Redis data is lost, damaged (`C logs redis` shows an append-only file error and the container restarts), or a bad change must be undone. The data newer than the backup (up to 6 hours: sign-ups, new API keys, quota counters, queued jobs) is gone; clients see 404 for a job that was queued.

Use the shell function `C` of the [README](README.md#your-shell-on-the-host). The one-off containers below use the image of the stack's Redis, so the version is the same.

```
BK=/var/lib/easysubway-data/easyconvert/redis-backups
VOL=easyconvert_redis-data
IMG=$(docker inspect --format '{{.Config.Image}}' easyconvert-redis)
```

1. **Pick and verify the backup.** The newest is normally right; take an older one when the newest holds the damage.
   ```
   ls -1 "$BK"/redis-*.rdb | tail -n 5
   F=$BK/redis-<UTC time>.rdb
   (cd "$BK" && sha256sum -c "$(basename "$F").sha256")
   ```
2. **Stop the stack and keep it stopped.** The hold stops the hourly reconcile from starting it.
   ```
   /opt/easyconvert/bin/deploy.sh hold
   C stop web worker redis
   ```
3. **Set the current data aside** (it is deleted in step 9, once the restore is proven). The command prints what is left in `/data`, which must be only `pre-restore`.
   ```
   docker run --rm --user 999:1000 --network none -v "$VOL":/data "$IMG" sh -c \
     'mkdir -p /data/pre-restore && for f in appendonlydir appendonly.aof dump.rdb; do if [ -e "/data/$f" ]; then mv "/data/$f" /data/pre-restore/; fi; done; ls -A /data'
   ```
4. **Put the dump in.**
   ```
   docker run --rm -i --user 999:1000 --network none -v "$VOL":/data "$IMG" sh -c 'cat > /data/dump.rdb' < "$F"
   ```
5. **Turn it into an append-only file.** A Redis that runs with `appendonly yes` loads the append-only file and ignores `dump.rdb`, so the dump is loaded by a throwaway server (no network, no password) with the file off, and `CONFIG SET appendonly yes` writes the file from memory. Note the key count it prints.
   ```
   docker run --rm --user 999:1000 --network none -v "$VOL":/data "$IMG" sh -c '
   redis-server --dir /data --appendonly no --save "" --protected-mode no > /tmp/loader.log 2>&1 &
   pid=$!
   n=0
   until redis-cli ping 2>/dev/null | grep -q PONG; do
     n=$((n + 1))
     state=$(cut -d" " -f3 /proc/$pid/stat 2>/dev/null)
     case "$state" in Z|"") echo "FAILED: the server exited; log follows"; cat /tmp/loader.log; exit 1 ;; esac
     [ $n -lt 600 ] || { echo "FAILED: the server did not answer in 5 minutes; log follows"; cat /tmp/loader.log; kill $pid; exit 1; }
     sleep 0.5
   done
   echo "keys loaded: $(redis-cli dbsize)"
   redis-cli config set appendonly yes > /dev/null
   n=0
   until redis-cli info persistence | tr -d "\r" | grep -q "^aof_rewrite_in_progress:0$"; do
     n=$((n + 1))
     [ $n -lt 600 ] || { echo "FAILED: the append-only file was not written in 5 minutes"; exit 1; }
     sleep 0.5
   done
   redis-cli info persistence | tr -d "\r" | grep -E "^aof_last_bgrewrite_status"
   redis-cli shutdown nosave; wait $pid; rm -f /data/dump.rdb; ls /data /data/appendonlydir'
   ```
   `aof_last_bgrewrite_status:ok` and an `appendonlydir` with a base and an incr file must be printed. If the command prints `FAILED`, the loader's log is printed with it (a dump from a newer Redis, or a damaged file): stop, try an older backup from step 1, and start again from step 3.
6. **Start the stack.** This runs the same checks as a deploy (health, the smoke conversion, the public site).
   ```
   /opt/easyconvert/bin/deploy.sh release
   /opt/easyconvert/bin/deploy.sh reconcile
   ```
7. **Check the data.** The key count is about the number of step 5 (traffic adds some):
   ```
   C exec -T redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli DBSIZE'
   ```
   Sign in with a known account and use one API key. `curl -s http://127.0.0.1:8090/api/health` must say `healthy`.
8. **Erase again what was erased after the backup.** The backup's time is in its name (UTC). For every account whose erasure finished after that time, that is every "deleted" notice in `support@aquilaxk.site` sent after it, and every request still open now (erased or not yet), whatever the date of its request, run the erase command of [Deleting an account](../deploy-oci.md#deleting-an-account) with `--apply`, then the rewrite of step 2 above. Until this is done, a deleted account can sign in again, so do it before anything else.
9. **Remove the set-aside copy** the same day. It is the old data, accounts deleted since the backup included, so it must not outlive the day:
   ```
   docker run --rm --user 999:1000 --network none -v "$VOL":/data "$IMG" rm -rf /data/pre-restore
   ```
   Check that it is gone: `docker run --rm --user 999:1000 --network none -v "$VOL":/data "$IMG" ls -A /data` must not list `pre-restore`.
10. Write the incident note ([incidents.md](incidents.md#after-it-is-over)) with the backup used and the time of data lost.

If Redis is damaged but you are unsure whether a restore is needed, steps 1 and 2 cost nothing; the stack is down only from step 2.

## Restore drills

The drill (`deploy/oci/redis-restore-drill.sh`) starts a throwaway Redis with the flags of the compose file, loads sample accounts, API keys, a queue and sessions with an expiry, backs up with the real `redis-backup.sh` (through a stand-in for `docker compose exec`, the only difference from the host), kills the instance and removes its data, restores by steps 3 to 6 above done with the binaries directly, and compares the key count, the types, sample values and an expiry with what was loaded, before and after one more restart. It uses no Docker and never touches production: `REDIS_BIN_DIR=<redis bin> bash deploy/oci/redis-restore-drill.sh <empty directory>`.

| Date | Where | Redis | Data | Backup | Restore (checksum check to a server that answers) | Result |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-08 | the maintainer's Mac, rehearsal of the script and the steps | 8.10.2 | 55,052 keys, 3.5 MB dump | 1.8 s, of which 1 s is the poll interval | 0.42 s | all values, types and the expiry equal, also after a restart |
| 2026-11-08 | the Linux test VM (Ubuntu 24.04 arm64), Redis built from the published 7.4.2 source (SHA-256 checked) | 7.4.2 | 50,000 sample accounts, 55,052 keys, 3.5 MB dump | 1.1 s | 0.35 s | all values, types and the expiry equal, also after a restart |

The drill on the Linux test VM with Redis 7.4.2 (the version line of the stack) is the one that counts, and it passed on 2026-11-08 (row above). The steps that need Docker (the `docker run` commands above) are not exercised by the drill; the first real restore, or a rehearsal on a second host, is their test. The human time of a restore is the ten steps, which is longer than the machine time by a wide margin.
