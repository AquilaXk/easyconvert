# Deploying EasyConvert on the shared OCI host

This page is the operations guide for the launch deployment. It covers the first-time setup, the capacity budget, how files are deleted, how to deploy and roll back, and how to grow later. The reasons for each choice are in `docs/policy-decisions.md`, entry 122. It belongs to the operations runbook of issue #900 and uses the configuration check of issue #564 (`docs/configuration.md`). Backups, restore drills, the incident procedure and the status page stay with #900.

## What runs

One host, one Compose project named `easyconvert`, started only by the deploy workflow.

| Service | Image | Port | Role |
| --- | --- | --- | --- |
| `web` | `ghcr.io/aquilaxk/easyconvert-web@sha256:...` | `127.0.0.1:8090` | Next.js server, API, synchronous conversions up to 100 MiB |
| `worker` | `ghcr.io/aquilaxk/easyconvert-worker@sha256:...` | none | Queue worker for every queue, 4 jobs at a time |
| `redis` | `redis:7.4-alpine@sha256:...` | none | Queue, users, API keys, quotas. Password, internal network |

The host nginx terminates TLS for `convert.aquilaxk.site` and proxies to `127.0.0.1:8090`. The CDN in front of the origin is the only client the firewall lets reach port 443.

| File | Purpose |
| --- | --- |
| `Dockerfile.web` | The web image: the worker image plus the Next.js build |
| `docker-compose.prod.yml` | The stack, with hard limits and loopback ports |
| `deploy/oci/nginx-easyconvert.conf` | nginx site for the domain |
| `deploy/oci/apparmor-easyconvert` | AppArmor profile of the web and worker containers |
| `deploy/oci/deploy.sh` | Deploy, rollback, reconcile, guard and sweep, run by the workflow |
| `deploy/oci/env-allowlist.txt` | The keys the env secret may carry |
| `.github/workflows/deploy-oci.yml` | Image build on main and the manual deploy |
| `CHANGELOG.md`, `.github/RELEASE_TEMPLATE.md` | The changelog and the template of the release notes written for each deploy ("Releases" below) |

Nothing here touches the other service's paths (`/opt/easysubway`, its nginx site, its cluster, its runner).

## First-time setup

Do these once per host, in this order. No step needs a secret value written in this repository. Steps 1 to 4 were done on 2026-10-30 and stay here so the host can be rebuilt; steps 5 to 8 remain for QA.

1. **Deploy user and directory** (done).
   ```
   sudo useradd --create-home --shell /bin/bash easyconvert-deploy
   sudo usermod -aG docker easyconvert-deploy
   sudo install -d -o easyconvert-deploy -g easyconvert-deploy -m 0750 /opt/easyconvert
   ```
   Membership of the `docker` group is root-equivalent on this host, so who can send a job to this user's runner matters. The runner takes only jobs that ask for its one label, `easyconvert-production` (step 3). In this repository only the deploy job asks for it, and that job runs only when started by hand on `main`, in the environment of step 4, after QA approves it. Any workflow file can name the label, though, including one on another branch or in a pull request from a fork. The fork setting of step 4 holds every workflow run of an outside contributor's pull request until it is approved, so read the workflow files of such a pull request before approving its run.

   **Residual trust.** Until the runner is narrowed, whoever can push a workflow file to this repository, and whoever approves the run of a fork's pull request, can run code as root-equivalent on the shared host. Today that is the owner alone. Narrowing the runner to a `sudoers` rule that allows only `deploy.sh deploy`, `rollback` and `reconcile`, so that the runner user leaves the `docker` group, is a row of the hardening backlog (#761); do it before anyone else gets write access.
2. **Scratch file system** (done). Uploads, results and every temporary file live on one file system of a fixed size, so a full scratch gives "no space left" to EasyConvert and never to the host. It is a file on the existing data volume, reserved up front:
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
   The images of this stack take about twice the size of one worker image while two releases exist, and the other service's data shares the volume. `deploy.sh` stops a deploy that would leave less than 15 GiB free. The cap is 12 GiB; raise it only after reading the `df` output.
3. **Runner** (done). A self-hosted Linux ARM64 runner, installed as the user `easyconvert-deploy` in `/home/easyconvert-deploy/actions-runner` as a service of its own, registered without the default labels so that `easyconvert-production` is its only label:
   ```
   ./config.sh --url https://github.com/AquilaXk/easyconvert --token <registration token from the settings page> --no-default-labels --labels easyconvert-production
   sudo ./svc.sh install easyconvert-deploy && sudo ./svc.sh start
   ```
   The registration token is shown once and expires within the hour. The runner of the other service keeps its own label and is not touched.
4. **Environment, secret and fork setting** (done).
   - The GitHub environment `easyconvert-production` allows deployments from `main` only and requires QA as reviewer.
   - The repository holds every workflow run of a pull request from an outside contributor's fork until it is approved. Check it with `gh api repos/AquilaXk/easyconvert/actions/permissions/fork-pr-contributor-approval --jq .approval_policy`, which must print `all_external_contributors`.
   - The environment has one secret, `EASYCONVERT_ENV`, a file of `KEY=VALUE` lines. Every secret in it is generated with `openssl rand -hex 32` (the password with `openssl rand -hex 24`). The keys, by name:

   | Key | Meaning |
   | --- | --- |
   | `APP_URL` | `https://convert.aquilaxk.site` |
   | `APP_ORIGIN` | Optional. The origin of sign-in redirects, `APP_URL` when absent |
   | `EASYCONVERT_SCRATCH_DIR` | `/var/lib/easysubway-data/easyconvert/scratch` |
   | `REDIS_PASSWORD` | Hex password of the stack's Redis |
   | `STORAGE_SIGNING_SECRET`, `JOB_SECRET_KEK`, `JWT_SECRET`, `KEY_HASH_PEPPER`, `WEBHOOK_SECRET_KEK` | Required secrets, 32 bytes or more each (`docs/configuration.md`) |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Only if sign-in with Google is enabled |
   | `EASYCONVERT_BUDGET_CPUS`, `EASYCONVERT_BUDGET_MEMORY_GB` | Optional budget, defaults 3.5 and 20 |
   | `STORAGE_DRIVER`, `S3_*`, `OCI_*`, `REDIS_URL` | Left out at launch. See "Scaling later" |

   The workflow keeps only the keys listed in `deploy/oci/env-allowlist.txt`. The job log is public. A dropped line is named there by its line number and never by any of its text, because a line that looks like a key can be the tail of a secret that a line break split off (the padding of a base64 value is upper case and ends in `=`). The image variables are not on the list, so the secret cannot replace the digests that the deploy pins.
5. **DNS** (QA). In the CDN dashboard add a proxied record for `convert.aquilaxk.site` that points at the public address of the instance, as the other site's record does. Set the SSL mode of the zone, or of this host name, to Full (strict).
6. **Origin certificate** (QA). In the CDN dashboard create an origin certificate for the host name. Port 80 is closed, so HTTP-01 cannot work, and DNS-01 would keep a DNS API token on the host. An origin certificate needs neither and is valid for up to 15 years. On the host:
   ```
   sudo install -d -m 0750 /etc/ssl/easyconvert
   sudo install -m 0644 origin.pem /etc/ssl/easyconvert/origin.pem
   sudo install -m 0600 origin.key /etc/ssl/easyconvert/origin.key
   ```
7. **AppArmor profile** (QA). Ubuntu 24.04 sets `kernel.apparmor_restrict_unprivileged_userns=1`, which refuses an unprivileged user namespace to a program under an AppArmor profile that does not grant one. Every native conversion runs in such a namespace (`unshare -r -n`). Docker's default profile (`docker-default`) is written for AppArmor ABI 3.0, which does not mediate the creation of a user namespace, and on this host `unshare -r -n` works in a container under both `docker-default` and `easyconvert` (measured on the host on 2026-10-30). The web and worker containers run under `easyconvert` anyway: Docker's default rules on ABI 4.0 with an explicit `userns` rule. The grant is then stated in a file of ours, and it holds if a later Docker release moves its default profile to ABI 4.0 or the host's setting changes; the setting itself stays as it is for the rest of the host. The profile pins the behaviour and the smoke conversion is the gate: a release that cannot run the sandbox does not go live. Docker refuses to start a container whose profile is not loaded, so do this before the first deploy. On the host, from a checkout of this repository:
   ```
   sudo install -m 0644 deploy/oci/apparmor-easyconvert /etc/apparmor.d/easyconvert
   sudo apparmor_parser -r -W /etc/apparmor.d/easyconvert
   sudo aa-status | grep -w easyconvert
   sudo -u easyconvert-deploy docker run --rm --user 10001:10001 --cap-drop ALL --security-opt no-new-privileges:true \
     --security-opt seccomp=docker/seccomp-worker.json --security-opt apparmor=easyconvert ubuntu:24.04 unshare -r -n -- echo ok
   ```
   `aa-status` must list `easyconvert` among the profiles in enforce mode, and the container must print `ok`. AppArmor loads the profiles of `/etc/apparmor.d` again at every boot. Install the file again, with the same commands, whenever `deploy/oci/apparmor-easyconvert` changes: a deploy compares it with `/etc/apparmor.d/easyconvert` (`cmp -s`) and stops, before it pulls anything, when they differ. After `up` the deploy also reads `docker inspect --format '{{.AppArmorProfile}}'` of the web and worker containers, which must print `easyconvert`, and runs `unshare -r -n` in the worker; a failure of either rolls the release back.

   What ABI 4.0 mediates that ABI 3.0 does not (the difference of `/etc/apparmor.d/abi/3.0` and `abi/4.0` of AppArmor 4.0.1 on Ubuntu 24.04.5, read on 2026-10-30): the creation of user namespaces (`namespaces` with `userns_create`, which the profile grants), POSIX message queues (`ipc` with `posix_mqueue`: create, read, write, open, delete, setattr, getattr), the capability `checkpoint_restore`, the network family `mctp`, and policy-format features (`permstable32`, `v9`, `outofband`). The profile grants every capability and network family except the ones it denies, so only the first two matter: the profile grants no rule for POSIX message queues, so they are denied. No engine of the stack is known to use them, and the smoke conversion exercises ImageMagick only; a conversion that fails with a permission error in a message-queue call is the sign to add a rule.
8. **nginx** (QA). On the host, from a checkout of this repository:
   ```
   sudo install -m 0644 deploy/oci/nginx-easyconvert.conf /etc/nginx/sites-available/easyconvert
   sudo ln -s /etc/nginx/sites-available/easyconvert /etc/nginx/sites-enabled/easyconvert
   sudo nginx -t && sudo systemctl reload nginx
   ```
   The site file defines no `default_server`, so the 444 default of the other site is unchanged, and no listener on port 80. All its zone and log names start with `easyconvert_`. Its edge log, `/var/log/nginx/easyconvert-edge.log`, is rotated by the distribution's `/etc/logrotate.d/nginx`, which covers `/var/log/nginx/*.log`. Do not add a stanza of its own: logrotate reports a log that two stanzas name as a duplicate and skips one of them, which can stop the rotation of the other site's logs. The distribution's stanza rotates by time and sets no size limit (read it with `cat /etc/logrotate.d/nginx`), and `/var/log` is watched neither by the scratch cap nor by the guard of `deploy.sh`, so a burst of requests can grow the log between two rotations. Look at `du -h /var/log/nginx/easyconvert-edge.log` when the free space of the boot volume shrinks.
9. **First deploy.** Run the workflow `deploy-oci` by hand (Actions, Run workflow) on `main` with action `deploy` and image_ref `main`, after a push to main has built the images. The job log ends with the two digests that are now running.
10. **Hourly guard and repair (optional).** Each deploy copies `deploy.sh` to `/opt/easyconvert/bin/`. To get a warning in the system log when the scratch or the volume fills, and to start the current release again when a cancelled job or a host restart left the stack down, add to the crontab of `easyconvert-deploy`: `0 * * * * /opt/easyconvert/bin/deploy.sh guard`, `15 * * * * /opt/easyconvert/bin/deploy.sh reconcile` and `30 4 * * * /opt/easyconvert/bin/deploy.sh sweep` (temporary files older than two hours). A deploy runs the guard and the sweep every time. `deploy`, `rollback` and `reconcile` take a lock (`/opt/easyconvert/deploy.lock`), so the hourly reconcile stops with "another deploy.sh is running" while a deploy is under way. It also starts the stack again after you stopped it by hand; remove the line while you hold the stack down.

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

Every container also has `memswap_limit` equal to its memory limit (no swap) and `cpu_shares: 512` against the default 1024, so the other service wins under contention and this stack uses idle cores otherwise. Every container has `oom_score_adj: 500`, which the kernel adds to its size-based score when the host as a whole runs out of memory. If the other service runs as Kubernetes pods, 500 ranks this stack above Guaranteed pods (-997) and above Burstable pods that request more than half of the host's memory, and below BestEffort pods (1000) and Burstable pods that request less than half (the score of a Burstable pod falls as its memory request grows; Kubernetes, "Node out-of-memory behavior"). The score only decides who goes first in a host-wide shortage. What protects the other service are the hard limits above. `pids_limit` caps the processes of each container. The per-user `nproc` limit is 4096: it counts every process of uid 10001 on the host, and the web and every worker run as that uid. A large file waits in the queue instead of being given more capacity. If four heavy jobs run together and pass 14 GiB, the kernel kills one process of the container and that job fails; raise the budget when the logs show it.

**One knob.** `EASYCONVERT_BUDGET_CPUS` and `EASYCONVERT_BUDGET_MEMORY_GB` in the env secret size the whole stack. `deploy/oci/deploy.sh budget` prints what they give, for example:

```
EASYCONVERT_BUDGET_CPUS=3.5 EASYCONVERT_BUDGET_MEMORY_GB=20 bash deploy/oci/deploy.sh budget
```

A per-service key in the secret (`EASYCONVERT_WORKER_CONCURRENCY` and the others in the allowlist) wins over the derived value. Re-measure the host after the first weeks of traffic and revisit the budget when the other service goes to production.

**Scratch and disk.** The scratch file system is 12 GiB (step 2). Logs are rotated at 5 MB, 3 files per container. The nginx edge log follows the distribution's rotation, which has no size limit (step 8). Only the current and the previous release of the images stay on disk.

## Delete on delivery

- Files are on host disk only (`STORAGE_DRIVER=local`). No bucket, no cloud copy.
- Each stored object has a time to live, 1 hour by default, and the local store sweeps expired objects every minute (`src/lib/storage/local-fs-storage.ts`). The synchronous routes `/api/convert` and `/api/convert/batch` keep nothing; they convert in memory and answer in the response.
- **Retention is set by two keys of the env secret**, `RESULT_UNDELIVERED_TTL_SECONDS` (3600: how long a result that nobody downloaded stays) and `RESULT_DELIVERED_GRACE_SECONDS` (600: how long a delivered result stays for a retry or a range request). Both are passed through to the application, whose schema holds the defaults, and the compose file sets none. The rules, their reasons and the open points are in the retention policy entry of `docs/policy-decisions.md` (entry 125, issue #665). The 12 GiB scratch cap bounds the worst case.
- `deploy.sh sweep` removes temporary files in `/tmp` of the worker that are older than two hours, and a deploy does the same before it starts the new release.

## Deploying

1. Merge to `main`. The `build` job builds the worker image and then the web image for arm64 and pushes them as `sha-<commit>` and `main`. The job summary lists the digests.
2. Run `deploy-oci` by hand with action `deploy` and image_ref `main` or `sha-<40 character commit>`; any other value is refused. The job runs on the `easyconvert-production` runner and:
   - checks that the scratch directory is a mount point and that the data volume has at least 15 GiB free, that the AppArmor profile loaded from `/etc/apparmor.d/easyconvert` is the file of the checkout (step 7), and that the budget in the secret can be used;
   - pulls both images, pins them by digest, and refuses the pair when the web image records another worker image than the one pinned (`org.opencontainers.image.base.name`, set by `Dockerfile.web`);
   - writes a mode 0600 env file, the compose file and the seccomp profile into `/opt/easyconvert/releases/<time>-<ref>/`;
   - runs `docker compose up -d --wait`, then checks `http://127.0.0.1:8090/api/health` for up to 150 seconds;
   - reads the AppArmor profile of the web and worker containers, which must be `easyconvert`;
   - converts a one-pixel PPM to PNG through `http://127.0.0.1:8090/api/convert`. ImageMagick decodes it in the sandbox, so this fails when the host does not let the sandbox run (the AppArmor profile of step 7), which the health check cannot see;
   - runs `unshare -r -n` in the worker container, because the smoke conversion goes through the web service only;
   - on success moves the `current` and `previous` links, keeps two releases, and removes the images that neither release names (by digest, from the two repositories of this stack only; there is no prune).

   The job log is public. It shows the digests, the line numbers of dropped lines of the secret, the HTTP status of a failed smoke conversion (never its answer) and, when a release fails its checks, the last 80 lines of the web and worker logs. The services are not meant to write a secret value to their logs, but no check proves it for every error path. Read the dump of a failed run before you treat its job log as free of secrets, and delete the run (Actions, the run's menu) if it shows one.

## Rolling back

- **Automatic.** When the new release does not become healthy, a container runs under another AppArmor profile, the smoke conversion fails or the worker cannot create its namespaces, `deploy.sh` starts the previous release again, removes the failed one (its env file included, also when the rollback fails too) and fails the job. With no previous release it stops the stack.
- **Cancelled job.** The workflow `exec`s `deploy.sh`, and every long command (`compose up --wait`, the health check and its waits, the smoke request) runs in a process group of its own that the script waits for with `wait`, so a cancel is handled at once. The script ends the command that is running, starts the previous release again (`up -d`, without waiting for it) and exits with 130; a second signal from the runner is ignored meanwhile. The runner kills the job a few seconds after the cancel, so the restart may be cut short.
- **Repair.** After a cancelled job, a failed rollback or a host restart, run `/opt/easyconvert/bin/deploy.sh reconcile` as `easyconvert-deploy`. It starts the `current` release from the digests pinned in its `images.env` and runs the same checks as a deploy. Deploying the current ref again would not do: a release of the ref `main` has no fixed name, and `main` may have moved.
- **By hand.** Run `deploy-oci` with action `rollback`. It starts the release behind the `previous` link and swaps the two links. The images of both releases are still on disk, so nothing is pulled. If it is cancelled, it starts the `current` release again. If the previous release does not become healthy, run `reconcile`.
- **Which digests are running.** `readlink /opt/easyconvert/current` and `cat /opt/easyconvert/current/images.env`.
- Redis keeps its data across both (volume `easyconvert_redis-data`).

## Releases

One version per production deploy, never one per pull request. The rule and its reasons are in entry 122 of `docs/policy-decisions.md`.

- **Number.** Beta releases are `0.y.z`. Raise `y` for a planned deploy batch and `z` for an urgent hotfix deploy. The first beta is `v0.1.0`, published as a pre-release. `1.0.0` comes when every conversion feature and the frontend are complete.
- **Build.** A version names a deploy, a build is named by its image tag `sha-<commit>`. The release notes name the tag that was deployed.
- **Before the deploy.** Move the `Unreleased` entries of `CHANGELOG.md` under the new version and its date, in a pull request. Copy `.github/RELEASE_TEMPLATE.md` into the body of the GitHub release, write each section by hand (leave out a section with nothing to say but keep the order) and create the tag on the commit that was deployed.

## Scaling later

The shape keeps the launch on one host and does not block growth. The web and the workers talk only through Redis and the storage driver's root, so none of the steps below needs a code change in the services.

1. **Scale up.** Resize the instance (a cost decision for QA), then raise `EASYCONVERT_BUDGET_CPUS` and `EASYCONVERT_BUDGET_MEMORY_GB`. Worker concurrency follows from the memory (one job per 3.4 GiB, `WORKER_CONCURRENCY` in `src/worker/index.ts`) and the image, spreadsheet and media limits read the same memory figures (`src/lib/conversions/image-input-limit-config.ts`, `src/lib/conversions/office/spreadsheet-limits.ts`, `MAX_IN_MEMORY_BYTES`). For an isolated heavy lane, start `--profile split`: a worker per resource class (`ResourceClass` in `src/lib/types.ts`, `WORKER_QUEUES` in `src/worker/index.ts`) with `EASYCONVERT_CLASS_<LIGHT|CPU|MEMORY|GPU>_REPLICAS`, `_CPUS`, `_MEMORY` and `_CONCURRENCY`, and set `EASYCONVERT_WORKER_REPLICAS=0` for the all-queue worker.
2. **Scale out.**
   - **Storage.** Set `STORAGE_DRIVER` to `s3` or `oci` with its variables (`src/lib/storage/storage-config.ts` resolves them; `src/lib/storage/oci-storage.ts` and `s3-compatible-storage.ts` are the drivers; `selected-storage.ts` picks one). Files must still not be kept. The retention policy (entry 125, #665) removes them within minutes, and the objects carry an expiry through `buildPutOptions` in `src/lib/storage/object-attributes.ts`. A bucket lifecycle rule is only a backstop, because the lifecycle rules of both providers work in days: set it to one day, and do not rely on it for the minutes-long promise.
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
- #665 retention policy and delete on delivery (policy entry 125, and the retention keys of the env secret).
- #691 atomic free-caller concurrency across instances (before a second web host).
