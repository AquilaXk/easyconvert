# Service metrics and objectives

This page says what the service measures about itself, how an operator reads it, and the objectives (availability and latency per family) that those measures are held against. The choices behind it are entry 178 of [policy-decisions.md](policy-decisions.md).

**Phase 1 (this page) is the metrics and the objectives.** The alerts on them (burn of the error budget, the age of the queue, the restarts of the worker) and the runbook entry each one links to come in phase 2 (issue #899). Until then nothing pages anyone; the scheduled readiness probe (`.github/workflows/uptime.yml`, entry 173) is the only alarm.

## The metrics

Each process serves them as text (the Prometheus exposition format) on `GET /metrics` of a listener of its own: the web process on port 9464, the worker on port 9465. The listener is internal:

- `docker-compose.prod.yml` publishes neither port, and the nginx site has no route to them (it refuses `/metrics` and `/api/metrics` too). Nothing outside the host can read them.
- A scraper reads them from the stack's networks (`web:9464`, and every worker container on 9465). Until one is set up, read a process by hand on the host: `docker compose exec -T web node -e "fetch('http://127.0.0.1:9464/metrics').then(r=>r.text()).then(console.log)"`, and the same in a worker container with 9465.
- `METRICS_PORT` changes the port (`0` turns the listener off) and `METRICS_HOST` the address ([configuration.md](configuration.md)).

Every label value comes from a closed list (`src/lib/metrics/labels.ts`); nothing from a request (file name, user, job, option, address) is a label, and the series count has a fixed upper bound.

| Label | Values |
|---|---|
| `family` | the category of the source format in the format registry: `image`, `document`, `archive`, `video`, `audio`, `ebook`, `spreadsheet`, `presentation`, `data`, `vector`, `font`, `cad`; `unknown` when the source is not known |
| `outcome` | `ok` (status below 400); `refused` (4xx: the service turned the request away, the client's to fix); `failed` (5xx); `timed_out` (504, the conversion ran past its deadline) |
| `route` | `convert` (`/api/convert`), `convert/batch`, `v1/convert` (`/api/v1/convert`); `other` for any route not on the list |
| `queue` | `default`, `light`, `cpu`, `memory`, `gpu` |
| `state` | `waiting`, `active`, `delayed` |
| `reason` | `spawn_error`, `sandbox_unavailable` |

| Metric | Type | Process | Meaning |
|---|---|---|---|
| `easyconvert_http_requests_total{route,family,outcome}` | counter | web | answers of the convert routes (the 401 and 429 they give included) |
| `easyconvert_http_request_duration_seconds{route,family,outcome}` | histogram | web | seconds from the start of the request to its answer; buckets 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 180 |
| `easyconvert_jobs_total{family,outcome}` | counter | worker | queue jobs that ended; a retried job counts once, when it ends |
| `easyconvert_job_duration_seconds{family,outcome}` | histogram | worker | seconds the last attempt ran (queue wait not included); buckets 0.1 to 3600 |
| `easyconvert_queue_jobs{queue,state}` | gauge | worker | jobs in the queue, read when scraped |
| `easyconvert_queue_oldest_waiting_age_seconds{queue}` | gauge | worker | how long the job that waited longest has waited; 0 when none waits |
| `easyconvert_queue_sample_failures_total` | counter | worker | scrapes in which the queue could not be read (its gauges are left out then) |
| `easyconvert_sandbox_spawn_failures_total{reason}` | counter | both | programs the sandbox did not start |
| `process_start_time_seconds` and the other default process metrics | gauge | both | a restart is `changes(process_start_time_seconds[1h])`; uptime is `time() - process_start_time_seconds` |

Notes for reading them:

- Counters start from 0 at a restart; use `rate()` and `increase()`, which handle that.
- Every worker reports all five queues, so take `max by (queue)` of the queue gauges. A worker that cannot be scraped (`up == 0`) is the signal when none is running; the queue gauges are gone with it.
- Only the three convert routes are timed. The job submission (`POST /api/v1/jobs`), the uploads and the pages are not; a job is measured by the worker metrics once it runs. An answer that a wrapper gives before the convert handler runs (a body declared too large, a full disk) is not counted. A batch counts under the family of its first file.
- The log lines of `src/lib/api/conversion-outcome-log.ts` are unchanged and remain the place to find which request failed; the metrics say how many.

## The objectives

The window is **28 days, rolling**. The objectives are **starting values**: no production traffic has been measured yet. They are a first reading against which the first 28 days of traffic are judged, and they are to be revised then (policy entry 178, "Revisit when").

**Availability** is the share of the requests that the service could be blamed for and answered. A refusal (4xx) is the client's to fix and is not counted against it; a 503, a 500 and a deadline overrun (504) are. For the synchronous routes:

```
sum(increase(easyconvert_http_requests_total{family="F",outcome="ok"}[28d]))
/
sum(increase(easyconvert_http_requests_total{family="F",outcome=~"ok|failed|timed_out"}[28d]))
```

For conversions run as queue jobs, the same with `easyconvert_jobs_total`.

**Latency** is the share of the answered conversions (`outcome="ok"`) that took at most the target. "The 95th percentile is at most T" is the same statement as "at least 95 percent took at most T", which is read off the bucket edge without interpolation (every target below is a bucket edge):

```
sum(increase(easyconvert_http_request_duration_seconds_bucket{family="F",outcome="ok",le="T"}[28d]))
/
sum(increase(easyconvert_http_request_duration_seconds_count{family="F",outcome="ok"}[28d]))   >= 0.95
```

For a graph, `histogram_quantile(0.95, sum by (le) (rate(easyconvert_http_request_duration_seconds_bucket{family="F",outcome="ok"}[1h])))`. For the run of a queue job, the same with `easyconvert_job_duration_seconds`; the wait in the queue is its own signal (`easyconvert_queue_oldest_waiting_age_seconds`) and gets its threshold with the alerts.

**Error budget** is what the availability target leaves: 0.5 percent of the eligible requests of a family in 28 days (about 3 hours 22 minutes of total outage, for a family that is asked for all the time).

| Family | Availability (28 days) | p95 latency of an answered conversion | Real-world corpus p95 (basis) |
|---|---|---|---|
| font | 99.5 % | 5 s | 0.6 s |
| cad | 99.5 % | 5 s | 0.4 s |
| archive | 99.5 % | 5 s | 1.0 s |
| audio | 99.5 % | 5 s | 1.0 s |
| data | 99.5 % | 10 s | 1.4 s |
| ebook | 99.5 % | 10 s | 1.3 s |
| spreadsheet | 99.5 % | 10 s | 2.4 s |
| image | 99.5 % | 20 s | 3.2 s |
| document | 99.5 % | 20 s | 3.9 s |
| video | 99.5 % | 20 s | 4.5 s |
| presentation | 99.5 % | 30 s | 7.1 s |
| vector | 99.5 % | 60 s | 10.1 s |

### Where the numbers come from

- **Latency.** The nightly real-world corpus run of 2026-11-07 (workflow `nightly.yml`, run 42358791023, artifact `realworld-results`) converted 18,794 files. Grouped by the registry category of the source, the 95th percentile of the files that converted is the last column. Each target is **four times that figure, rounded up to the next of 5, 10, 20, 30 and 60 s, and never below 5 s**. The factor of four is an assumption, not a measurement: the corpus times the conversion alone, in one process on a CI runner, and production adds the request, the queue, the sandbox start and a host with 3.5 cores shared by the web and the worker. The floor of 5 s keeps a family measured on fifty files (font, cad, ebook) from getting a target finer than the overhead.
- **The nightly speed rows** (`bench/`, the parity gate) compare each conversion with the reference tool and pass when the lower bound of the speed ratio is at least 0.90; of the 221 rows of the same night, 220 were at or above the reference and 1 was a tracked gap now at parity, none failing. They give a ratio, not a duration, so they say that no family is slower than its reference tool beyond the allowance; they do not set a figure.
- **The deploy smoke** (`deploy/oci/deploy.sh`) converts one 1x1 picture through the sandbox and fails the release when it is not answered within 60 s. It proves that the path from the proxy to the sandbox works and gives an upper bound of 60 s for the smallest conversion; it is not a latency measurement, and the objectives above are not derived from it.
- **Availability.** The same corpus run had no crash, no hang and no output that failed its check: 18,294 conversions answered, 500 files refused (4xx), none failed. A fault of the engines is not what is expected to cost availability; the host is: a single machine, restarted for each deployment, with no second replica. 99.5 percent leaves about 3 hours 22 minutes in 28 days for that, which the 15-minute readiness probe can see. The same value is given to every family because the corpus shows no difference between them; a family that costs more than its share of the budget gets its own value at the first review.
- **Limits that bound the figures.** A synchronous conversion is cut at 120 s (`SYNC_DEADLINE_MAX_MS`, `src/lib/queue/job-deadline.ts`), and the CDN in front of the origin closes a request that waits more than 100 s for its first byte, so no latency target is above 60 s. A conversion that needs longer is a job (`POST /api/v1/jobs`).

## What is not here yet

Phase 2 of issue #899 adds the alert rules (burn of the error budget of the figures above, the age of the queue, the restart rate of the worker), the scraper that evaluates them, and the runbook entry each alert links to. Structured JSON logs with a request or job id are not part of phase 1: the outcome lines of the convert routes already carry a request id and redact file names and passwords, and the job logs are unchanged.
