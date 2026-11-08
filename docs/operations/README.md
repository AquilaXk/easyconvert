# Operations runbook

For whoever is on call. There is one maintainer (the operator) and QA, who decides what the operator may not decide alone ([incidents.md](incidents.md)). Production is one OCI arm64 host that runs EasyConvert alone, with Docker Compose. This is issue #900; the reasons are policy entry 186 of [policy-decisions.md](../policy-decisions.md).

| You see | Go to |
| --- | --- |
| The site is down, or the Uptime workflow failed | [incidents.md](incidents.md), then [Deploy and roll back](#deploy-and-roll-back) below |
| An alert fired | [alerts.md](alerts.md): [error budget burn](alerts.md#alert-error-budget-burn), [queue age](alerts.md#alert-queue-age), [worker restarts](alerts.md#alert-worker-restarts) |
| Redis lost data, or must be restored | [backup-and-restore.md](backup-and-restore.md#restore) |
| An account deletion request arrived | [backup-and-restore.md](backup-and-restore.md#account-deletion-and-backups) |

## Your shell on the host

Log in as `easyconvert-deploy`. Every command in these pages uses this function; paste it first.

```
C() { docker compose --project-name easyconvert --project-directory /opt/easyconvert/current \
  --env-file /opt/easyconvert/current/.env -f /opt/easyconvert/current/docker-compose.prod.yml --profile redis "$@"; }
```

| Look at | Command |
| --- | --- |
| Containers and their state | `C ps` |
| Last lines of a service (`web`, `worker`, `redis`) | `C logs --no-color --tail 200 worker` |
| Which release runs | `readlink /opt/easyconvert/current; cat /opt/easyconvert/current/images.env` |
| Readiness, as the Uptime workflow reads it | `curl -s http://127.0.0.1:8090/api/health` |
| Liveness, as the container health check reads it (the process serves; no Redis, storage or worker is asked; loopback only) | `curl -s http://127.0.0.1:8090/api/health/live` |
| Disk | `df -h /var/lib/easysubway-data; /opt/easyconvert/bin/deploy.sh guard` |
| Metrics of the web process | `C exec -T web node -e "fetch('http://127.0.0.1:9464/metrics').then(r=>r.text()).then(console.log)"` |
| Metrics of a worker | the same with `worker` and port 9465 |
| Redis | `C exec -T redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli INFO memory'` (the password stays in the container) |

Do not paste the contents of `/opt/easyconvert/current/.env` anywhere. The deploy job log is public.

## Deploy and roll back

[deploy-oci.md](../deploy-oci.md) is the procedure; this page does not repeat it. In short:

- **Deploy.** Merge to `main`, wait for the image build, run the workflow `deploy-oci` by hand with action `deploy` and image_ref `main` or `sha-<commit>` ([Deploying](../deploy-oci.md#deploying)). It checks health, a smoke conversion and the public site, and rolls back by itself when one fails.
- **Roll back.** Run `deploy-oci` with action `rollback`: it starts the release behind `/opt/easyconvert/previous`, whose images are still on the host, and swaps the two links ([Rolling back](../deploy-oci.md#rolling-back)). Redis keeps its data across it.
- **The stack is down after a cancelled job or a reboot.** On the host, `/opt/easyconvert/bin/deploy.sh reconcile`. It does nothing while `/opt/easyconvert/hold` exists (`deploy.sh release` removes it).
- **Which tag to roll back to.** The previous release. `cat /opt/easyconvert/previous/images.env` shows its digests; the release directory name carries the time and the ref.

Roll back first when an alert starts within an hour after a deploy; look for the cause afterwards.

## Object storage

There is none. Uploads, results and scratch live on the capped scratch file system of the host and are deleted 10 minutes after the download, or an hour after the conversion when nobody downloads them ([Delete on delivery](../deploy-oci.md#delete-on-delivery)). There is nothing to back up or restore, and the privacy policy promises there is no backup of files. A lost scratch disk loses only the files in flight.

## What else is where

| Page | Content |
| --- | --- |
| [backup-and-restore.md](backup-and-restore.md) | Redis persistence, backup schedule and retention, restore, the restore drills |
| [incidents.md](incidents.md) | Severity levels, who acts, how users are told |
| [alerts.md](alerts.md) | One entry per alert of [slo.md](../slo.md) |
| [deploy-oci.md](../deploy-oci.md) | Host setup, deploy, rollback, reconcile, account deletion |
| [slo.md](../slo.md) | The metrics and the objectives |
