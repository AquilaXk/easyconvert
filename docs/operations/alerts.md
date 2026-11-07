# Alert runbook

One entry for each alert that [slo.md](../slo.md) names: the burn of the error budget, the age of the queue, the restarts of the worker. The alert rules and the scraper that evaluates them are phase 2 of #899; each alert will link to the anchor of its entry below, and until then nothing pages anyone, so the entries are also what to follow when you see the same symptom by hand. The thresholds (how fast a burn, how many seconds of age, how many restarts) are set with the rules, not here; every entry starts from "the alert fired" or "you saw this".

Commands use the shell function `C` of the [README](README.md#your-shell-on-the-host). Each entry ends with how to know it is over. For the incident levels and who is told, see [incidents.md](incidents.md).

## Alert: error budget burn

**Anchor for the alert:** `docs/operations/alerts.md#alert-error-budget-burn`.

**Means.** A family (image, document, video and so on) is failing, timing out or answering slowly faster than its objective allows ([slo.md](../slo.md#the-objectives)): 99.5 percent available over 28 days, and its p95 latency. Failures are counted as `outcome` `failed` (5xx) and `timed_out` (504) of `easyconvert_http_requests_total` and `easyconvert_jobs_total`; a refusal (4xx) is the client's and does not burn. Users see "something went wrong" or a conversion that does not end. Level: SEV2 for one family, SEV1 when every family burns or the public probe fails.

**First, 5 minutes.**

1. Which family, which route, which outcome. Read the web metrics (README) and compare the three outcomes per `family` and `route`; one family with the others quiet points at an engine or a file type, all families at the host or Redis.
2. Did a deploy happen in the last hour? `readlink /opt/easyconvert/current` (the time is in the name). If yes, **roll back** ([Deploy and roll back](README.md#deploy-and-roll-back)) and watch the burn stop; investigate afterwards.
3. Look at the failures: `C logs --no-color --since 30m web | grep ' failure '` (the lines are `[route] failure {...}` with a request id, the status, the family and the class of the error; file names and passwords are not in them).

**Find the cause.**

| You see | Cause | Do |
| --- | --- | --- |
| `easyconvert_sandbox_spawn_failures_total` rises; `sandbox_unavailable` | The sandbox cannot start (AppArmor profile changed, a kernel update, a missing user namespace) | `C exec -T worker unshare -r -n -- true` must succeed; `docker inspect --format '{{.AppArmorProfile}}' easyconvert-web` must print `easyconvert`; `sudo aa-status | grep -w easyconvert`; load the profile again as in step 7 of [deploy-oci.md](../deploy-oci.md#first-time-setup). A kernel or AppArmor update just before it is the likely cause, and rolling back the release does not help |
| `spawn_error` for one program | An engine binary is missing or crashes in this image | Roll back to the image before; open a bug with the log line |
| 503 with `Retry-After`; disk above 95 percent | Scratch is full; uploads and conversions are refused ([Delete on delivery](../deploy-oci.md#delete-on-delivery)) | `df -h /var/lib/easysubway-data`; `/opt/easyconvert/bin/deploy.sh sweep`; look for a stuck staging directory; results are deleted early by themselves from 85 percent. A disk that fills for good is an incident of its own |
| 503, "quota store offline", or Redis not `healthy` in `C ps` | Redis is down or full | See [Redis alert checks](#redis-checks) below |
| `timed_out` for one family; the latency objective burns | A slow input, a host under load, or an engine that hangs | Check `top` on the host and `docker stats --no-stream`; one huge job holds the CPU; the 120 s deadline ends it by itself. Do not raise the deadline |
| Everything fails, the site answers | The web or worker container is restarting | `C ps`, then the worker entry [below](#alert-worker-restarts) |

<a id="redis-checks"></a>
**Redis checks.** `C ps` (is it `healthy`), `C logs --no-color --tail 50 redis`, and `C exec -T redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli INFO memory'`: `used_memory` close to the 256 MB limit means writes are refused (`noeviction`). The queue and the counters grow with load, ended jobs go after 25 hours; a Redis that is full of something else is a bug: keep the output of `INFO keyspace` and `MEMORY STATS`, and raise it with QA before changing the limit. Data damaged or gone: [Restore](backup-and-restore.md#restore).

**Over when.** The failing family answers 200 again (convert a small file of it through the public site), the burn rate the alert reads is back below its threshold, and the Uptime workflow is green. Write the incident note if it was SEV1, or SEV2 for more than an hour.

## Alert: queue age

**Anchor for the alert:** `docs/operations/alerts.md#alert-queue-age`.

**Means.** The job that has waited longest in a queue has waited too long (`easyconvert_queue_oldest_waiting_age_seconds{queue}`, the largest value of any worker, `max by (queue)`). Jobs are accepted (`POST /api/v1/jobs` answers) but not started. The queues are `default`, `light`, `cpu`, `memory` and `gpu`; at launch one `worker` container serves all of them with 4 jobs at a time, and the `split` and `gpu` profiles are off. Level: SEV2; SEV1 when the age grows and no worker is running.

**Check.**

1. Is a worker running? `C ps worker`. Not running or restarting: [worker restarts](#alert-worker-restarts) first. In the metrics, no worker answers means no queue gauges at all (the `up == 0` signal).
2. Is the queue readable? `easyconvert_queue_sample_failures_total` rising means the worker cannot read Redis: [Redis checks](#redis-checks).
3. Is the worker busy or stuck? Read the worker metrics (README, port 9465): `easyconvert_queue_jobs{state="active"}` at the concurrency of 4 for a long time, and `easyconvert_jobs_total` not rising, mean the slots are held by long jobs or hung ones. `C logs --no-color --tail 100 worker` shows the jobs, and a line "ignored its abort ... Recycling the worker" is the engine hanging (the worker recycles itself).
4. A job sits in `delayed`? A retry waiting for its backoff is normal; the age counts the waiting set only.

**Do.**

| Cause | Action |
| --- | --- |
| The worker is down or crash-looping | [Worker restarts](#alert-worker-restarts) |
| Redis unreachable or full | [Redis checks](#redis-checks) |
| A burst of heavy jobs (a queue of large videos or documents) | Wait; the age falls as the queue drains. Check that the rate of `easyconvert_jobs_total` is not zero. Do not raise `EASYCONVERT_WORKER_CONCURRENCY` or the budget: the host has 3.5 cores for web and worker, and a change of the env secret needs QA and a deploy |
| One job hangs the slot and does not end | The stalled sweep and the deadline end it; if the worker does not recycle in 5 minutes, `C restart worker` (the stalled sweep retries or fails the job) |

Do not delete jobs from Redis by hand: the steps the worker takes when a job ends (settling the quota, the webhook) would not run.

**Over when.** `easyconvert_queue_oldest_waiting_age_seconds` is 0 or falling for every queue, and a job submitted through the public API (a small PNG to JPG) completes.

## Alert: worker restarts

**Anchor for the alert:** `docs/operations/alerts.md#alert-worker-restarts`.

**Means.** A worker process started again more often than expected (`changes(process_start_time_seconds[1h])` of the worker job). Some restarts are by design: the worker drains and exits when it has handled its number of jobs or its memory (`WORKER_MAX_RSS_MB`, 4096) is over the line, and when a job ignored its abort; the container restarts it (`restart: unless-stopped`). A rate above that, or restarts that do not stop, are a crash loop. Jobs of a killed worker are found by the stalled sweep (it runs every 15 seconds and acts once the job's heartbeat has expired) and retried or failed. Level: SEV2; SEV1 when the worker never stays up.

**Check.**

1. State and count: `docker inspect --format 'restarts={{.RestartCount}} oomkilled={{.State.OOMKilled}} exit={{.State.ExitCode}} started={{.State.StartedAt}}' $(C ps -q worker)`.
2. Why it stopped: `C logs --no-color --tail 200 worker`. "Self-recycling triggered (reason: ...)" is by design; the reason is `job_count` or `rss_memory`. A stack trace is a crash. `OOMKilled=true` means the container passed its memory limit (14 GiB at the default budget): one job needs more than the host gives.
3. The host: `free -m`, `dmesg -T | tail` (the kernel's OOM killer), `df -h /var/lib/easysubway-data` (a full disk stops the worker from writing).
4. Did a deploy just change it? `readlink /opt/easyconvert/current`.

**Do.**

| Cause | Action |
| --- | --- |
| Started right after a deploy | Roll back |
| `rss_memory` recycles every few minutes | A job type leaks or is heavy. Find the family in the logs (the job lines carry it); keep the log; no action is needed for the service while jobs finish, open a bug |
| `OOMKilled=true` | The job that was running when it died is the cause. Its input is in the log line with the request id; do not run it again by hand on the host. Roll back if it started with a deploy; otherwise open a bug and keep the log |
| A crash with a stack trace at start (config, Redis URL, sandbox) | The log names it; a bad env secret needs QA and a deploy, never an edit in `current/.env` |
| Redis refuses the connection | [Redis checks](#redis-checks) |

**Over when.** The worker has stayed up for 30 minutes (`C ps worker` shows the `Up` time), `RestartCount` stopped rising, the queue age is 0, and a small conversion through the API completes.
