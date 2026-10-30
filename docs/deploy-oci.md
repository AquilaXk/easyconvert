# Deploying EasyConvert on the shared OCI host

This page is the operations guide for the launch deployment. It covers the first-time setup, the capacity budget, how files are deleted, how to deploy and roll back, and how to grow later. The reasons for each choice are in `docs/policy-decisions.md`, entry 122. It belongs to the operations runbook of issue #900 and uses the configuration check of issue #564 (`docs/configuration.md`). Backups, restore drills, the incident procedure and the status page stay with #900.

## What runs

One host, one Compose project named `easyconvert`, started only by the deploy workflow.

| Service | Image | Port | Role |
| --- | --- | --- | --- |
| `web` | `ghcr.io/aquilaxk/easyconvert-web@sha256:...` | `127.0.0.1:8090` | Next.js server, API, synchronous conversions up to 100 MiB |
| `worker` | `ghcr.io/aquilaxk/easyconvert-worker@sha256:...` | none | Queue worker for every queue, 4 jobs at a time |
| `redis` | `redis:7.4-alpine@sha256:...` | none | Queue, users, API keys, quotas. Password, internal network |

The host nginx terminates TLS for `easyconvert.aquilaxk.site` (a proposed name, QA confirms it) and proxies to `127.0.0.1:8090`. The CDN in front of the origin is the only client the firewall lets reach port 443.

| File | Purpose |
| --- | --- |
| `Dockerfile.web` | The web image: the worker image plus the Next.js build |
| `docker-compose.prod.yml` | The stack, with hard limits and loopback ports |
| `deploy/oci/nginx-easyconvert.conf` | nginx site for the domain |
| `deploy/oci/logrotate-easyconvert.conf` | Rotation of the JSON edge log |
| `deploy/oci/deploy.sh` | Deploy, rollback, guard and sweep, run by the workflow |
| `deploy/oci/env-allowlist.txt` | The keys the env secret may carry |
| `.github/workflows/deploy-oci.yml` | Image build on main and the manual deploy |

Nothing here touches the other service's paths (`/opt/easysubway`, its nginx site, its cluster, its runner).

## First-time setup

Do these once, in this order. No step needs a secret value written in this repository.

1. **DNS.** In the CDN dashboard add a proxied record for `easyconvert.aquilaxk.site` that points at the public address of the instance, as the other site's record does. Set the SSL mode of the zone, or of this host name, to Full (strict).
2. **Origin certificate.** In the CDN dashboard create an origin certificate for the host name. Port 80 is closed, so HTTP-01 cannot work, and DNS-01 would keep a DNS API token on the host. An origin certificate needs neither and is valid for up to 15 years. On the host:
   ```
   sudo install -d -m 0750 /etc/ssl/easyconvert
   sudo install -m 0644 origin.pem /etc/ssl/easyconvert/origin.pem
   sudo install -m 0600 origin.key /etc/ssl/easyconvert/origin.key
   ```
3. **Scratch file system.** Uploads, results and every temporary file live on one file system of a fixed size, so a full scratch gives "no space left" to EasyConvert and never to the host. It is a file on the existing data volume, reserved up front:
   ```
   base=/var/lib/easysubway-data/easyconvert
   sudo install -d -m 0755 "$base" "$base/scratch"
   sudo fallocate -l 12G "$base/scratch.img"
   sudo mkfs.ext4 -q -F -m 0 -L ecscratch "$base/scratch.img"
   echo "$base/scratch.img $base/scratch ext4 loop,nosuid,nodev,noexec,nofail 0 2" | sudo tee -a /etc/fstab
   sudo mount "$base/scratch"
   sudo install -d -o 10001 -g 10001 -m 0750 "$base/scratch/storage" "$base/scratch/tmp-web" "$base/scratch/tmp-worker"
   df -h /var/lib/easysubway-data "$base/scratch"
   ```
   Check the `df` line first: the images of this stack take about twice the size of one worker image while two releases exist, and the other service's data shares the volume. `deploy.sh` stops a deploy that would leave less than 15 GiB free. The cap is 12 GiB; raise it only after reading the `df` output.
4. **Deploy user and directory.**
   ```
   sudo useradd --create-home --shell /bin/bash easyconvert-deploy
   sudo usermod -aG docker easyconvert-deploy
   sudo install -d -o easyconvert-deploy -g easyconvert-deploy -m 0750 /opt/easyconvert
   ```
   Membership of the `docker` group is root-equivalent on this host. The deploy workflow is the only thing that runs as this user, and it is restricted to `main` and to the environment below.
5. **Runner.** In the repository settings (Actions, Runners) add a self-hosted Linux ARM64 runner. Install it as the user `easyconvert-deploy` in `/home/easyconvert-deploy/actions-runner`, with the extra label `easyconvert-production`, and as a service of its own:
   ```
   ./config.sh --url https://github.com/AquilaXk/easyconvert --token <registration token from the settings page> --labels easyconvert-production
   sudo ./svc.sh install easyconvert-deploy && sudo ./svc.sh start
   ```
   The registration token is shown once and expires within the hour. The runner of the other service keeps its own label and is not touched.
6. **Environment and secret.** Create the GitHub environment `easyconvert-production`. Restrict deployments to the `main` branch and require QA as reviewer. Add one secret named `EASYCONVERT_ENV`, a file of `KEY=VALUE` lines. Generate every secret with `openssl rand -hex 32` (the password with `openssl rand -hex 24`). The keys, by name:
   | Key | Meaning |
   | --- | --- |
   | `APP_URL` | `https://easyconvert.aquilaxk.site` |
   | `EASYCONVERT_SCRATCH_DIR` | `/var/lib/easysubway-data/easyconvert/scratch` |
   | `REDIS_PASSWORD` | Hex password of the stack's Redis |
   | `STORAGE_SIGNING_SECRET`, `JOB_SECRET_KEK`, `JWT_SECRET`, `KEY_HASH_PEPPER`, `WEBHOOK_SECRET_KEK` | Required secrets, 32 bytes or more each (`docs/configuration.md`) |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Only if sign-in with Google is enabled |
   | `EASYCONVERT_BUDGET_CPUS`, `EASYCONVERT_BUDGET_MEMORY_GB` | Optional budget, defaults 3.5 and 20 |
   | `STORAGE_DRIVER`, `S3_*`, `OCI_*`, `REDIS_URL` | Left out at launch. See "Scaling later" |

   The workflow keeps only the keys listed in `deploy/oci/env-allowlist.txt`. A key that is not listed is dropped and its name (never its value) is written to the job log. The image variables are not on the list, so the secret cannot replace the digests that the deploy pins.
7. **nginx.** On the host, from a checkout of this repository:
   ```
   sudo install -m 0644 deploy/oci/nginx-easyconvert.conf /etc/nginx/sites-available/easyconvert
   sudo ln -s /etc/nginx/sites-available/easyconvert /etc/nginx/sites-enabled/easyconvert
   sudo install -m 0644 deploy/oci/logrotate-easyconvert.conf /etc/logrotate.d/easyconvert
   sudo nginx -t && sudo systemctl reload nginx
   ```
   The site file defines no `default_server`, so the 444 default of the other site is unchanged, and no listener on port 80. All its zone and log names start with `easyconvert_`.
8. **First deploy.** Run the workflow `deploy-oci` by hand (Actions, Run workflow) on `main` with action `deploy` and image_ref `main`, after a push to main has built the images. The job log ends with the two digests that are now running.
9. **Hourly guard (optional).** Each deploy copies `deploy.sh` to `/opt/easyconvert/bin/`. To get a warning in the system log when the scratch or the volume fills, add to the crontab of `easyconvert-deploy`: `0 * * * * /opt/easyconvert/bin/deploy.sh guard` and `30 4 * * * /opt/easyconvert/bin/deploy.sh sweep` (temporary files older than two hours). A deploy runs the guard and the sweep every time.

## Capacity budget

The stack gets 3.5 OCPU and 20 GiB out of the instance's 4 OCPU and 24 GB. The other service is in development at launch and needs little. The limits are hard, so neither side can exhaust the host.

Measured on `easysubway-a1` over the last 7 days (OCI monitoring, hourly aggregates, read only):

| Metric | Mean | 95th percentile | Maximum |
| --- | --- | --- | --- |
| CPU, hourly mean | 4.7% | | 5.4% |
| CPU, hourly maximum | 13% | 23% | 47% |
| Memory, hourly maximum | 15.7% | 16.1% | 19.5% |

On 4 OCPU and 24 GB that is about 0.2 OCPU on average, peaks near 1.9 OCPU, and at most about 4.7 GB of memory.

| Service | CPU limit | Memory limit | Why |
| --- | --- | --- | --- |
| `worker` | 2.5 | 14 GiB | 4 jobs. The input limits are sized for about 3.4 GiB per job (a memory-class worker in `docker-compose.yml` has 14 GiB), so office, video and large raster jobs fit. At most 2 jobs per cpu |
| `web` | 0.8 | 5.5 GiB | Synchronous conversions run in this process (up to 100 MiB per request) |
| `redis` | 0.2 | 512 MiB | `maxmemory 256mb`, no eviction, plus the append-only rewrite |
| Total | 3.5 | 20 GiB | Leaves 0.5 OCPU and 4 GiB for the other service and the system |

Every container also has `memswap_limit` equal to its memory limit (no swap) and `cpu_shares: 512` against the default 1024, so the other service wins under contention and this stack uses idle cores otherwise. A large file waits in the queue instead of being given more capacity. If four heavy jobs run together and pass 14 GiB, the kernel kills one process of the container and that job fails; raise the budget when the logs show it.

**One knob.** `EASYCONVERT_BUDGET_CPUS` and `EASYCONVERT_BUDGET_MEMORY_GB` in the env secret size the whole stack. `deploy/oci/deploy.sh budget` prints what they give, for example:

```
EASYCONVERT_BUDGET_CPUS=3.5 EASYCONVERT_BUDGET_MEMORY_GB=20 bash deploy/oci/deploy.sh budget
```

A per-service key in the secret (`EASYCONVERT_WORKER_CONCURRENCY` and the others in the allowlist) wins over the derived value. Re-measure the host after the first weeks of traffic and revisit the budget when the other service goes to production.

**Scratch and disk.** The scratch file system is 12 GiB (step 3). Logs are rotated at 5 MB, 3 files per container, and the nginx edge log daily for 7 days. Only the current and the previous release of the images stay on disk.

## Delete on delivery

- Files are on host disk only (`STORAGE_DRIVER=local`). No bucket, no cloud copy.
- Each stored object has a time to live, 1 hour by default, and the local store sweeps expired objects every minute (`src/lib/storage/local-fs-storage.ts`). The synchronous routes `/api/convert` and `/api/convert/batch` keep nothing; they convert in memory and answer in the response.
- **Not done yet.** Deleting an input and its result right after the user has downloaded it needs a change to the download route (`src/app/api/storage/file/[...key]/route.ts`) and the job record, with range requests and retries in mind. No environment variable sets the time to live today. This is the next pull request, tracked in #665 together with the retention policy page. Until then a result stays for at most the hour, and the 12 GiB scratch cap bounds the worst case.
- `deploy.sh sweep` removes temporary files in `/tmp` of the worker that are older than two hours, and a deploy does the same before it starts the new release.

## Deploying

1. Merge to `main`. The `build` job builds the worker image and then the web image for arm64 and pushes them as `sha-<commit>` and `main`. The job summary lists the digests.
2. Run `deploy-oci` by hand with action `deploy` and image_ref `main` or `sha-<commit>`. The job runs on the `easyconvert-production` runner and:
   - checks that the scratch directory is a mount point and that the data volume has at least 15 GiB free;
   - pulls both images and pins them by digest;
   - writes a mode 0600 env file, the compose file and the seccomp profile into `/opt/easyconvert/releases/<time>-<ref>/`;
   - runs `docker compose up -d --wait`, then checks `http://127.0.0.1:8090/api/health` for up to 150 seconds;
   - on success moves the `current` and `previous` links, keeps two releases, and removes the images that neither release names (by digest, from the two repositories of this stack only; there is no prune).

## Rolling back

- **Automatic.** When the new release does not become healthy, `deploy.sh` starts the previous release again, removes the failed one and fails the job. With no previous release it stops the stack.
- **By hand.** Run `deploy-oci` with action `rollback`. It starts the release behind the `previous` link and swaps the two links. The images of both releases are still on disk, so nothing is pulled.
- **Which digests are running.** `readlink /opt/easyconvert/current` and `cat /opt/easyconvert/current/images.env`.
- Redis keeps its data across both (volume `easyconvert_redis-data`).

## Scaling later

The shape keeps the launch on one host and does not block growth. The web and the workers talk only through Redis and the storage driver's root, so none of the steps below needs a code change in the services.

1. **Scale up.** Resize the instance (a cost decision for QA), then raise `EASYCONVERT_BUDGET_CPUS` and `EASYCONVERT_BUDGET_MEMORY_GB`. Worker concurrency follows from the memory (one job per 3.4 GiB, `WORKER_CONCURRENCY` in `src/worker/index.ts`) and the image, spreadsheet and media limits read the same memory figures (`src/lib/conversions/image-input-limit-config.ts`, `src/lib/conversions/office/spreadsheet-limits.ts`, `MAX_IN_MEMORY_BYTES`). For an isolated heavy lane, start `--profile split`: a worker per resource class (`ResourceClass` in `src/lib/types.ts`, `WORKER_QUEUES` in `src/worker/index.ts`) with `EASYCONVERT_CLASS_<LIGHT|CPU|MEMORY|GPU>_REPLICAS`, `_CPUS`, `_MEMORY` and `_CONCURRENCY`, and set `EASYCONVERT_WORKER_REPLICAS=0` for the all-queue worker.
2. **Scale out.**
   - **Storage.** Set `STORAGE_DRIVER` to `s3` or `oci` with its variables (`src/lib/storage/storage-config.ts` resolves them; `src/lib/storage/oci-storage.ts` and `s3-compatible-storage.ts` are the drivers; `selected-storage.ts` picks one). Files must still not be kept. Delete on delivery (#665) removes them within minutes, and the objects carry an expiry through `buildPutOptions` in `src/lib/storage/object-attributes.ts`. A bucket lifecycle rule is only a backstop, because the lifecycle rules of both providers work in days: set it to one day, and do not rely on it for the minutes-long promise.
   - **Redis.** Run Redis on its own host and set `REDIS_URL` in the secret (read in `src/lib/queue/bullmq-engine.ts`, `src/lib/health/probes.ts`, `src/lib/api-keys/redis-key-store.ts`). The compose file then leaves its own Redis off.
   - **Workers.** Add hosts that run `docker-compose.prod.yml` with the same `REDIS_URL` and storage driver and start only `worker`. They join the same queues, and the stalled-job sweep (`STALLED_SWEEP_INTERVAL_MS` in `bullmq-engine.ts`) re-queues the jobs of a host that disappears.
   - **Web.** Put more than one origin behind the CDN. Every web host needs the same `JWT_SECRET`, `KEY_HASH_PEPPER` and the shared Redis. Client addresses stay correct as long as each host's nginx overwrites `X-Forwarded-For` as the site file does (`docs/client-ip-trust.md`).
3. **Open prerequisite.** Issue #691. The free-caller concurrency limit (`src/lib/queue/concurrency-limit.ts`) counts synchronous conversions per web process, and its check is not atomic. With two web hosts a caller can hold the limit on each. Make it a shared Redis counter before the second web host takes traffic.

## Cost

Every resource below exists already or is free, so this deployment adds no cost. Nothing here depends on a paid tier.

| Resource | State | Cost |
| --- | --- | --- |
| Instance `easysubway-a1` (4 OCPU, 24 GB, arm64, ap-seoul-1) | Existing, not resized | Existing resource, no added cost |
| Boot volume (50 GB) and data volume (50 GB) | Existing. The scratch file system is a 12 GiB file on the data volume; images and the Redis volume live in the container runtime's data root on it. No volume is added | Existing resources, no added cost |
| Public address, security list, port 443 to the CDN ranges | Existing | Existing resources, no added cost |
| nginx on the host | The site file is added to the existing nginx | No added cost |
| CDN, TLS and DNS | Free plan; an origin certificate instead of a paid or renewing one | Free |
| Container images | GHCR, public repository | Free |
| Image builds | GitHub-hosted arm64 runner, public repository | Free |
| Deploy runner | A second service on the existing instance, same operating system | No added cost |
| Object storage | Not used. User files stay on host disk | None |
| Load balancer, paid monitoring | Not used. Health checks are Compose healthchecks, the deploy check and the log | None |
| Outbound traffic | Results are served by our origin through the CDN. Oracle documents a free monthly outbound allowance for the tenancy (check the current figure in the OCI price list); the CDN's free plan caches nothing of the private results, so every download is origin traffic | Within the free allowance at launch volume; measure it |

## Related issues

- #900 operations runbook (this page is its deploy and rollback part; backups, the restore drill and the incident procedure stay open there).
- #564 configuration checked at start-up (the required secrets above).
- #665 retention policy and delete on delivery (the next pull request).
- #691 atomic free-caller concurrency across instances (before a second web host).
