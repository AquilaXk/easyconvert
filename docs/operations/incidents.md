# Incident procedure

An incident is anything that stops or damages the service for its users, or exposes their data. The operator is the one maintainer; QA is the owner who decides. There is no second person on call and no pager (alerts are phase 2 of #899), so the first alarm is the Uptime workflow's failure mail ([policy entry 173](../policy-decisions.md)), a user's mail to `support@aquilaxk.site`, or the operator noticing.

## Severity

| Level | Means | Examples | Act within | Users |
| --- | --- | --- | --- | --- |
| SEV1 | The service is down, data is lost or exposed, or a security hole is open | Uptime workflow failed twice in a row; every conversion fails; Redis lost its data; a secret leaked; someone else's file or account is readable | start at once; work until stabilised | tell them (below) |
| SEV2 | Working, but a part is broken or slow | One family fails; the queue waits for minutes; sign-in with Google fails; downloads fail | the same day | tell them when it lasts over an hour |
| SEV3 | A flaw with a way round | A wrong output for one format pair; a slow page | the next working days, as an issue | no |

When unsure between two levels, take the higher.

## Who acts

- **Operator** (the maintainer): triages, rolls back, reconciles, restarts a container, writes the notice and the note.
- **QA** decides: a public statement beyond the template below, a shutdown of the service on purpose for more than an hour, a deploy to production when the fix is not a rollback, a restore of Redis from a backup (it discards the data newer than the backup, so the operator asks as soon as the decision is needed), any spending, any secret rotation, and whether to tell the authorities. The operator informs QA of every SEV1 as soon as the service is stable enough to write two lines, and of every SEV2 at the end of the day.
- An incident does not lift the need for QA's approval of a deploy, a secret change or a destructive action. A rollback and a reconcile do not need it: they start a release that already ran.

## First 15 minutes

1. **Look** ([README](README.md#your-shell-on-the-host)): `C ps`, `curl -s http://127.0.0.1:8090/api/health`, `C logs --no-color --tail 100 web worker redis`, `df -h /var/lib/easysubway-data`. Note the time (UTC) you started.
2. **Name the level** from the table.
3. **Did a deploy just happen?** (`readlink /opt/easyconvert/current` and the time in its name.) If it did, roll back now ([Deploy and roll back](README.md#deploy-and-roll-back)); find the cause later.
4. **Match the symptom:**
   - alert: [alerts.md](alerts.md);
   - Redis down or its data gone: [backup-and-restore.md](backup-and-restore.md#restore);
   - the host is unreachable: the instance's console in the cloud dashboard (QA's account), then `/opt/easyconvert/bin/deploy.sh reconcile` once it is back;
   - everything is fine on the host but the site is down from outside: the CDN dashboard and the origin certificate (`deploy-oci.md`, steps 5 and 6).
5. **Stop the bleeding before the cause**: roll back, restart a stuck container (`C restart worker`), free the disk. Never rotate a secret or delete data to "see if it helps".
6. **A leak or a breach** (SEV1): take the affected path out (`/opt/easyconvert/bin/deploy.sh hold` then `C stop web`), keep the logs (`C logs --no-color web worker > <file>` in a directory only you can read), and inform QA at once. Do not delete anything that is evidence.

## How users are told

There is no status page ([policy entry 186](../policy-decisions.md#186-redis-is-backed-up-every-6-hours-to-the-hosts-data-volume-for-7-days-an-account-is-erased-within-2-days-and-the-status-of-the-service-is-the-uptime-workflows-public-run-history)). The channels, and nothing else:

| Who | Channel |
| --- | --- |
| Anyone who wants to know whether the service is up | The run history of the [Uptime workflow](https://github.com/AquilaXk/easyconvert/actions/workflows/uptime.yml): a red run is an outage seen from outside, a green one is a healthy probe (every 15 minutes) |
| A user who writes to `support@aquilaxk.site` | A personal answer from that mailbox, in the language of the mail, within one working day; say what is wrong, what is known, and when you will write again |
| API customers who have a business agreement | Mail from the same mailbox, without undue delay once a personal data breach that affects their data is known (the data processing terms promise this) |
| Everyone, for a SEV1 that lasts over an hour, or any breach | QA decides the statement; the operator drafts it from the template below |

Template, in the language of the audience, no blame, no guesses: *"Since <UTC time>, <what users cannot do>. We are working on it. Your files are not affected: they are deleted minutes after delivery. We will write again by <time>."* Never promise a time you cannot keep; never say "no data was affected" until you have checked. After it is over, one more message: when it ended and what is different now.

A personal data breach that affects accounts is also a legal question (the privacy policy and the Korean and EU rules set time limits for telling the people and the authority): the operator informs QA the same hour, and QA decides.

## After it is over

Within 3 days, as a note in the pull request or issue that fixes it (an issue only if the work spans several pull requests):

- start, end, level, how it was noticed, and how long that took;
- what users saw;
- the cause, with the evidence (log lines, metric readings), not a guess;
- what was done and what was lost (for a restore: the backup used and the hours of data lost);
- what changes so it does not repeat, as rows in `TODO.md`; and the runbook line that was missing or wrong, fixed here.

The error budget of [slo.md](../slo.md) is read after the incident: an outage of a family that used most of its 28-day budget is a reason to stop deploying until the cause is fixed.
