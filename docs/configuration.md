# Configuration

<!-- Generated from src/lib/config/schema.ts by `npm run config:docs`. Do not edit by hand. -->

EasyConvert reads 157 environment variables. The schema in `src/lib/config/schema.ts` declares each one with its type, default, production requirement and owning area; this page and `docs/configuration.example.env` are generated from it.

## How the configuration is checked

- The web server (`src/instrumentation.ts`) and the worker (`src/worker/index.ts`) validate the whole environment once at start-up, before they connect to anything, and keep the result frozen.
- A variable that is unset, or set to an empty or blank value, takes its default. Compose files and shells pass unused variables as empty strings, so empty counts as unset.
- A variable that is set but malformed is an error in every environment. It never falls back to the default.
- With `NODE_ENV=production` the variables marked as required must be set, and secrets must be long enough. `next build` has no runtime environment, so requirements are not enforced there (`NEXT_PHASE=phase-production-build`).
- Every failing variable is reported in one `ConfigurationError` that names the variable and the rule it broke. The value is never printed. The process exits with a non-zero status.
- Secrets have no default. Their length is measured on the UTF-8 text exactly as the code that uses them reads it: hex and base64 are not decoded, so `openssl rand -hex 32` (64 characters) is a valid secret.
- The Process column says which process reads the variable and enforces its production requirement: `web` is the Next.js server, `worker` the queue worker.

Generate a secret with `openssl rand -hex 32`.

## Variables

### Runtime

| Variable | Type and rule | Default | Required in production | Process |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | text | none | no | web, worker |
| `NEXT_PHASE` | text | none | no | web, worker |
| `NEXT_RUNTIME` | text | none | no | web |
| `PATH` | text | none | no | web, worker |
| `KUBERNETES_SERVICE_HOST` | text | none | no | web, worker |
| `CONTAINER_SANDBOX` | text | none | no | web, worker |
| `MALLOC_ARENA_MAX` | integer, 1 to 2147483647 | none | no | web, worker |

- `NODE_ENV`: Runtime mode. Only the value `production` switches on production start-up validation and production-only behaviour; any other value is treated as development.
- `NEXT_PHASE`: Set by Next.js. During `next build` (`phase-production-build`) production requirements are not enforced.
- `NEXT_RUNTIME`: Set by Next.js to `nodejs` or `edge`; the start-up hook runs only under `nodejs`.
- `PATH`: Directories searched for the native conversion tools and handed to sandboxed child processes.
- `KUBERNETES_SERVICE_HOST`: Set by Kubernetes. Any non-empty value marks the process as already container-isolated.
- `CONTAINER_SANDBOX`: Any non-empty value declares that the process already runs inside a container sandbox.
- `MALLOC_ARENA_MAX`: glibc allocator arena limit per process. When set (for example to `2` in the worker container), the image pipeline may lease up to 8 threads instead of the unbounded-heap cap of 2.

### Network and public URLs

| Variable | Type and rule | Default | Required in production | Process |
| --- | --- | --- | --- | --- |
| `APP_URL` | URL with the scheme `http` or `https` | `http://localhost:3000` (development only) | when `STORAGE_DRIVER` is `local` | web |
| `APP_ORIGIN` | URL with the scheme `http` or `https` | none | no | web |
| `METRICS_PORT` | integer, 0 to 65535 | 9464 in the web process, 9465 in the worker | no | web, worker |
| `METRICS_HOST` | text | `127.0.0.1` | no | web, worker |
| `NEXT_PUBLIC_APP_URL` | URL with the scheme `http` or `https` | none | no | web |

- `APP_URL`: Public origin of this application, used to build the URLs of local-driver uploads. Required in production when STORAGE_DRIVER is `local`.
- `APP_ORIGIN`: Canonical origin used for OAuth redirects and the same-origin check of the API; takes precedence over NEXT_PUBLIC_APP_URL.
- `METRICS_PORT`: Port of the metrics listener (GET /metrics), which every process opens beside its own service. `0` turns the listener off. It is not the web application's port and must not be published or proxied (docs/slo.md).
- `METRICS_HOST`: Address the metrics listener binds to. The default is the loopback address; the container stack sets `0.0.0.0` so that a scraper on the internal compose network can reach it.
- `NEXT_PUBLIC_APP_URL`: Public origin exposed to the browser; used when APP_ORIGIN is not set.

### Client address trust and sandbox

| Variable | Type and rule | Default | Required in production | Process |
| --- | --- | --- | --- | --- |
| `STRICT_SANDBOX` | `true` or `false` | `false` | no | web, worker |
| `SANDBOX_PID_NAMESPACE` | `true` or `false` | `true` | no | web, worker |
| `SANDBOX_HIDE_PROC` | `true` or `false` | `true` | no | web, worker |
| `SANDBOX_CONFINE_FILES` | `true` or `false` | `true` | no | web, worker |
| `SANDBOX_LAUNCHER` | one of `auto`, `off` (any case) | `auto` | no | web, worker |
| `HTML_IMAGE_FETCH` | one of `on`, `off` (any case) | `on` | no | web, worker |
| `TRUSTED_PROXIES` | comma-separated IPv4/IPv6 addresses or CIDR ranges or `none`, at most 256 entries | none | no | web |
| `TRUSTED_CDN` | one of `cloudflare` (any case) | none | no | web |
| `TRUSTED_CDN_RANGES` | comma-separated IPv4/IPv6 addresses or CIDR ranges, at most 256 entries | none | no | web |
| `TRUSTED_PROXY_HEADER` | one of `x-forwarded-for`, `forwarded` (any case) | none | no | web |

- `STRICT_SANDBOX`: Set to `true` to refuse running native tools without the strict process sandbox: the user and network namespaces, and pid-init with the Landlock ruleset that confines the files of a program to the directory of its job. A run that does not name its job directory, or that this host cannot confine, is refused with a 503 before the program starts.
- `SANDBOX_PID_NAMESPACE`: Set to `false` to start sandboxed programs without `pid-init` (on by default): without the PID namespace of their own, and without the Landlock ruleset that refuses them the /proc entries (command line, status) of the other runs. calibre and veraPDF always run outside the PID namespace: calibre's launcher reads /proc/<its own id>/exe, which names another process in a namespace whose /proc the sandbox cannot remount; they still get the ruleset.
- `SANDBOX_HIDE_PROC`: Set to `false` to start sandboxed programs without the Landlock ruleset that refuses them the /proc entries (command line, status) of the other runs (on by default; `pid-init --keep-proc`). The PID namespace stays. A single call can opt out with `sandboxOptions.hideProc: false`.
- `SANDBOX_CONFINE_FILES`: Set to `false` to start sandboxed programs without the Landlock ruleset that confines their files to the directory of their job (on by default; `pid-init --confine`). Without it a program can read and write every file its user can, such as the stored files of other people. STRICT_SANDBOX does not override an explicit `false`; the PID namespace and the /proc hiding stay.
- `SANDBOX_LAUNCHER`: Whether sandboxed native tools are started by the persistent low-heap launcher process instead of forked directly from the worker. `auto` (the default) uses the launcher when available and falls back to a direct start; `off` always starts programs directly.
- `HTML_IMAGE_FETCH`: Whether the public http and https images of an HTML page are fetched and embedded when it is converted to PDF. `on` (the default) fetches them in a separate, credential-free child process that needs outbound TCP 80 and 443 to public addresses (see docker/AIRGAP.md for the network policy). `off` for deployments without egress: no image is fetched, and each external image is left out of the PDF with a warning (a request with `requireResources` is refused).
- `TRUSTED_PROXIES`: Comma-separated IPv4/IPv6 addresses or CIDR ranges of the reverse proxies in front of the server, or `none` for a directly exposed server. Production should declare one of TRUSTED_PROXIES or TRUSTED_CDN; the edge middleware answers API requests with 503 until it does (docs/client-ip-trust.md).
- `TRUSTED_CDN`: Name of the CDN whose edge ranges are trusted to forward client addresses.
- `TRUSTED_CDN_RANGES`: CIDR ranges that replace the built-in edge ranges of TRUSTED_CDN.
- `TRUSTED_PROXY_HEADER`: The one forwarding header the trusted proxy writes: `x-forwarded-for` (default) or `forwarded`.

### Sign-in

| Variable | Type and rule | Default | Required in production | Process |
| --- | --- | --- | --- | --- |
| `JWT_SECRET` | secret, at least 32 bytes of UTF-8 text in production (the text is measured, never decoded); secret, never logged | none | yes | web |
| `JWT_SECRET_PREVIOUS` | secret, at least 32 bytes of UTF-8 text in production (the text is measured, never decoded); secret, never logged | none | no | web |
| `GOOGLE_CLIENT_ID` | text | none | no | web |
| `GOOGLE_CLIENT_SECRET` | secret text; secret, never logged | none | no | web |
| `SMTP_HOST` | text | none | no | web |
| `SMTP_PORT` | integer, 1 to 65535 | `587` | no | web |
| `SMTP_USER` | secret text; secret, never logged | none | no | web |
| `SMTP_PASSWORD` | secret text; secret, never logged | none | no | web |
| `MAIL_FROM` | text | none | no | web |

- `JWT_SECRET`: Signs session tokens. At least 32 bytes of UTF-8 text in production; also a legacy decryption fallback key of the credential vault and of API key secret encryption.
- `JWT_SECRET_PREVIOUS`: The previous JWT_SECRET during a key rotation, so session tokens signed under it still verify while new tokens are signed with JWT_SECRET. Used exactly as set, like JWT_SECRET, without trimming.
- `GOOGLE_CLIENT_ID`: OAuth client id for Google sign-in. Without it, development uses a local mock sign-in and production refuses to sign in.
- `GOOGLE_CLIENT_SECRET`: OAuth client secret for Google sign-in; required together with GOOGLE_CLIENT_ID.
- `SMTP_HOST`: SMTP server that sends the password reset and email verification mails (STARTTLS is required, a mail is never sent in the clear). Without SMTP_HOST, SMTP_USER and SMTP_PASSWORD, and a public origin (APP_ORIGIN, NEXT_PUBLIC_APP_URL or APP_URL), both features are off: the sign-in page shows no forgot-password link and their routes answer 404.
- `SMTP_PORT`: Port of SMTP_HOST. 587 (STARTTLS) is the default; 465 connects over TLS from the first byte.
- `SMTP_USER`: Account that signs in to SMTP_HOST: the full account address (for a mailbox provider, not a short name).
- `SMTP_PASSWORD`: Password of SMTP_USER: an application password, not the sign-in password of the account.
- `MAIL_FROM`: Sender of the mails: an address, or `Name <address>`. Defaults to SMTP_USER. A mailbox provider accepts only the account or one of its aliases.

### Keys and secrets

| Variable | Type and rule | Default | Required in production | Process |
| --- | --- | --- | --- | --- |
| `KEY_HASH_PEPPER` | secret, at least 32 bytes of UTF-8 text in production (the text is measured, never decoded); secret, never logged | none | yes | web |
| `KEY_HASH_PEPPER_PREVIOUS` | secret, at least 32 bytes of UTF-8 text in production (the text is measured, never decoded); secret, never logged | none | no | web |
| `KEY_ENCRYPTION_KEY` | secret, at least 32 bytes of UTF-8 text in production (the text is measured, never decoded); secret, never logged | none | no | web, worker |
| `WEBHOOK_SECRET_KEK` | secret, at least 32 bytes of UTF-8 text in production (the text is measured, never decoded); secret, never logged | none | yes | web, worker |
| `STORAGE_VAULT_KEY` | secret, at least 32 bytes of UTF-8 text in production (the text is measured, never decoded); secret, never logged | none | no | web, worker |
| `JOB_SECRET_KEK` | secret, at least 32 bytes of UTF-8 text in production (the text is measured, never decoded), no surrounding whitespace in production; secret, never logged | none | yes | web, worker |
| `JOB_SECRET_KEK_PREVIOUS` | secret, at least 32 bytes of UTF-8 text in production (the text is measured, never decoded), no surrounding whitespace in production; secret, never logged | none | no | web, worker |

- `KEY_HASH_PEPPER`: Pepper of the HMAC that hashes API key secrets. At least 32 bytes of UTF-8 text in production. Also a legacy decryption fallback key of API key secret encryption.
- `KEY_HASH_PEPPER_PREVIOUS`: The previous KEY_HASH_PEPPER during a rotation, so API keys hashed under it still verify and are re-hashed under KEY_HASH_PEPPER on next use.
- `KEY_ENCRYPTION_KEY`: Key that encrypts API key webhook secrets at rest. In production it must be set (at least 32 characters) to encrypt a new secret; without it existing secrets still decrypt under KEY_HASH_PEPPER, KEY_HASH_PEPPER_PREVIOUS or JWT_SECRET. Outside production those keys also encrypt.
- `WEBHOOK_SECRET_KEK`: Key-encryption key of the webhook signing secrets. At least 32 bytes of UTF-8 text in production. The web process seals the rotated secrets with it and the worker opens them to sign every delivery, so both need the same value.
- `STORAGE_VAULT_KEY`: Master key of the vault that holds customer storage credentials. In production it must be set (at least 32 characters) to store credentials; without it stored credentials still decrypt under KEY_ENCRYPTION_KEY or JWT_SECRET. Outside production those keys also encrypt.
- `JOB_SECRET_KEK`: Key-encryption key that seals signed URLs and headers inside queued jobs. At least 32 bytes of UTF-8 text, no surrounding whitespace, in production. Shared by the API and every worker.
- `JOB_SECRET_KEK_PREVIOUS`: The previous JOB_SECRET_KEK during a rotation, so jobs sealed under it can still be opened.

### Object storage

| Variable | Type and rule | Default | Required in production | Process |
| --- | --- | --- | --- | --- |
| `STORAGE_DRIVER` | one of `oci`, `s3`, `local` (any case) | `local` (development only) | yes | web, worker |
| `STORAGE_SIGNING_SECRET` | secret, at least 32 bytes of UTF-8 text in production (the text is measured, never decoded), surrounding whitespace is trimmed; secret, never logged | none | one of `STORAGE_SIGNING_SECRET`, `S3_SIGNING_SECRET`, `OCI_SIGNING_SECRET` | web, worker |
| `S3_SIGNING_SECRET` | secret, at least 32 bytes of UTF-8 text in production (the text is measured, never decoded), surrounding whitespace is trimmed; secret, never logged | none | one of `STORAGE_SIGNING_SECRET`, `S3_SIGNING_SECRET`, `OCI_SIGNING_SECRET` | web, worker |
| `OCI_SIGNING_SECRET` | secret, at least 32 bytes of UTF-8 text in production (the text is measured, never decoded), surrounding whitespace is trimmed; secret, never logged | none | one of `STORAGE_SIGNING_SECRET`, `S3_SIGNING_SECRET`, `OCI_SIGNING_SECRET` | web, worker |
| `EASYCONVERT_STORAGE_DIR` | file or directory path | .easyconvert/storage under the working directory | no | web, worker |
| `RESULT_UNDELIVERED_TTL_SECONDS` | integer, 60 to 86400 | `3600` | no | web, worker |
| `RESULT_DELIVERED_GRACE_SECONDS` | integer, 1 to 3600 | `600` | no | web, worker |
| `RESULT_DISK_HIGH_PERCENT` | integer, 1 to 99 | `85` | no | web, worker |
| `RESULT_DISK_LOW_PERCENT` | integer, 1 to 99 | `80` | no | web, worker |
| `RESULT_DISK_REFUSE_PERCENT` | integer, 1 to 99 | `95` | no | web, worker |
| `OCI_NAMESPACE` | text | none | no | web, worker |
| `OCI_REGION` | text | ap-seoul-1 (in-memory OCI emulation only) | no | web, worker |
| `OCI_BUCKET` | text | easyconvert-transcode-bucket (in-memory OCI emulation only) | no | web, worker |
| `OCI_BUCKET_NAME` | text | none | no | web, worker |
| `OCI_ENDPOINT` | URL with the scheme `http` or `https`, `https` only in production, no user info | none | no | web, worker |
| `OCI_ACCESS_KEY_ID` | secret text; secret, never logged | none | no | web, worker |
| `OCI_SECRET_ACCESS_KEY` | secret text; secret, never logged | none | no | web, worker |
| `S3_ENDPOINT` | URL with the scheme `http` or `https`, `https` only in production, no user info | none | no | web, worker |
| `S3_REGION` | text | none | no | web, worker |
| `S3_BUCKET` | text | none | no | web, worker |
| `S3_BUCKET_NAME` | text | none | no | web, worker |
| `S3_ACCESS_KEY_ID` | secret text; secret, never logged | none | no | web, worker |
| `S3_SECRET_ACCESS_KEY` | secret text; secret, never logged | none | no | web, worker |
| `S3_FORCE_PATH_STYLE` | `true` or `false` | `true` | no | web, worker |
| `AWS_ACCESS_KEY_ID` | secret text; secret, never logged | none | no | web, worker |
| `AWS_SECRET_ACCESS_KEY` | secret text; secret, never logged | none | no | web, worker |
| `AWS_REGION` | text | none | no | web, worker |
| `AWS_BUCKET_NAME` | text | none | no | web, worker |
| `BYOS_HTTP_DEV_ENDPOINT_ALLOWLIST` | text | none | no | web, worker |
| `BYOS_S3_DEV_ENDPOINT_ALLOWLIST` | text | none | no | web, worker |

- `STORAGE_DRIVER`: Where objects live: `oci` (OCI Object Storage), `s3` (an S3-compatible service) or `local` (disk of this host, for development and single-node use). Must be chosen in production.
- `STORAGE_SIGNING_SECRET`: Signs upload and download URLs. At least 32 bytes of UTF-8 text in production (surrounding whitespace is trimmed). One of STORAGE_SIGNING_SECRET, S3_SIGNING_SECRET or OCI_SIGNING_SECRET is required in production; the first one set wins.
- `S3_SIGNING_SECRET`: Alternative name of STORAGE_SIGNING_SECRET; used when STORAGE_SIGNING_SECRET is not set.
- `OCI_SIGNING_SECRET`: Alternative name of STORAGE_SIGNING_SECRET; used when neither STORAGE_SIGNING_SECRET nor S3_SIGNING_SECRET is set.
- `EASYCONVERT_STORAGE_DIR`: Directory of the local storage driver and of the API key, usage and file stores. Share it between the API and the workers.
- `RESULT_UNDELIVERED_TTL_SECONDS`: Seconds a conversion result is kept when nobody has downloaded it completely, counted from the moment it is stored; after that it is deleted and its download answers 410 Gone. The upload a job reads is deleted shortly after the last job that reads it ends (RESULT_DELIVERED_GRACE_SECONDS) and does not wait for this. Applies to every storage driver; a bucket lifecycle rule is only a backstop.
- `RESULT_DELIVERED_GRACE_SECONDS`: Seconds a conversion result stays downloadable after its first complete delivery (one response, or ranges that together cover the whole file), so a second click or a resumed download still works. After that it is deleted and its download answers 410 Gone. A download that stops early does not count as a delivery.
- `RESULT_DISK_HIGH_PERCENT`: Disk use, in percent of the file system that holds EASYCONVERT_STORAGE_DIR, above which the sweep deletes results before their time: delivered results in their grace period first, the earliest delivery first, then undelivered results, the oldest first, until the use is at or below RESULT_DISK_LOW_PERCENT. A pass that deleted nothing, or whose deletions together did not lower the use, waits five minutes unless the use moved. The files of a queued or running job, undelivered results younger than ten minutes and partly downloaded results are never deleted. Such a result answers 410 Gone with the reason `capacity`. Local storage driver only; must be above RESULT_DISK_LOW_PERCENT and below RESULT_DISK_REFUSE_PERCENT.
- `RESULT_DISK_LOW_PERCENT`: Disk use, in percent, at or below which the early deletion that RESULT_DISK_HIGH_PERCENT starts stops again. Local storage driver only; must be below RESULT_DISK_HIGH_PERCENT.
- `RESULT_DISK_REFUSE_PERCENT`: Disk use, in percent, above which new uploads and conversions answer 503 with Retry-After, after an early deletion of results did not bring the use down to it, measured on the fuller of the file system that holds EASYCONVERT_STORAGE_DIR and the temporary directory; the parts, completion and abort of a running upload go on. Local storage driver only; must be above RESULT_DISK_HIGH_PERCENT and at most 99.
- `OCI_NAMESPACE`: OCI Object Storage namespace (a single DNS label). Required when STORAGE_DRIVER is `oci`; checked when storage is selected.
- `OCI_REGION`: OCI region (lowercase letters, digits, hyphens). Required when STORAGE_DRIVER is `oci`; only the in-memory OCI emulation falls back to a region.
- `OCI_BUCKET`: OCI bucket name. Required when STORAGE_DRIVER is `oci` (OCI_BUCKET_NAME is accepted instead); only the in-memory OCI emulation falls back to a bucket.
- `OCI_BUCKET_NAME`: Alternative name of OCI_BUCKET; used when OCI_BUCKET is not set.
- `OCI_ENDPOINT`: Overrides the S3-compatible endpoint derived from the namespace and region (private endpoint, test server). https in production.
- `OCI_ACCESS_KEY_ID`: Customer secret key id of the OCI S3-compatible API. Required when STORAGE_DRIVER is `oci`.
- `OCI_SECRET_ACCESS_KEY`: Customer secret key of the OCI S3-compatible API. Required when STORAGE_DRIVER is `oci`.
- `S3_ENDPOINT`: Endpoint of the S3-compatible service. Required when STORAGE_DRIVER is `s3`. https in production.
- `S3_REGION`: Region of the S3-compatible service (lowercase letters, digits, hyphens). Required when STORAGE_DRIVER is `s3`.
- `S3_BUCKET`: Bucket name. Required when STORAGE_DRIVER is `s3` (S3_BUCKET_NAME is accepted instead).
- `S3_BUCKET_NAME`: Alternative name of S3_BUCKET; used when S3_BUCKET is not set.
- `S3_ACCESS_KEY_ID`: Access key id of the S3-compatible service. Required when STORAGE_DRIVER is `s3`.
- `S3_SECRET_ACCESS_KEY`: Secret access key of the S3-compatible service. Required when STORAGE_DRIVER is `s3`.
- `S3_FORCE_PATH_STYLE`: Path-style bucket addressing. Set to `false` for virtual-hosted-style addressing.
- `AWS_ACCESS_KEY_ID`: Deprecated fallback of OCI_ACCESS_KEY_ID and S3_ACCESS_KEY_ID; logs a warning when used.
- `AWS_SECRET_ACCESS_KEY`: Deprecated fallback of OCI_SECRET_ACCESS_KEY and S3_SECRET_ACCESS_KEY; logs a warning when used.
- `AWS_REGION`: Deprecated fallback of OCI_REGION and S3_REGION; logs a warning when used.
- `AWS_BUCKET_NAME`: Deprecated fallback of OCI_BUCKET and S3_BUCKET; logs a warning when used.
- `BYOS_HTTP_DEV_ENDPOINT_ALLOWLIST`: Comma-separated host:port list of WebDAV, Azure Blob, GCS and import/export URL endpoints that may be plain http or private-address, for a local test server. Honoured only when NODE_ENV is exactly `development`.
- `BYOS_S3_DEV_ENDPOINT_ALLOWLIST`: Comma-separated host[:port] list of customer S3 endpoints that may be plain http or private-address. Honoured only when NODE_ENV is exactly `development`.

### Queue and Redis

| Variable | Type and rule | Default | Required in production | Process |
| --- | --- | --- | --- | --- |
| `REDIS_URL` | URL with the scheme `redis` or `rediss`; secret, never logged | none | no | web, worker |
| `REDIS_HOST` | text | none | no | web, worker |
| `REDIS_PORT` | integer, 1 to 65535 | `6379` | no | web, worker |
| `EASYCONVERT_WORKER_ENABLED` | `true` or `false` | `false` | no | web |

- `REDIS_URL`: Redis connection URL (`redis://` or `rediss://`, may carry a password). With neither REDIS_URL nor REDIS_HOST set, the queue and stores run in memory (development only).
- `REDIS_HOST`: Redis host, used when REDIS_URL is not set.
- `REDIS_PORT`: Redis port, used with REDIS_HOST.
- `EASYCONVERT_WORKER_ENABLED`: Set to `true` to run the queue worker inside the web process (single-node use).

### Worker

| Variable | Type and rule | Default | Required in production | Process |
| --- | --- | --- | --- | --- |
| `WORKER_CONCURRENCY` | integer, 1 to 1024 | `3` | no | worker |
| `WORKER_MAX_JOBS` | integer, 0 to 2147483647 | `1000` | no | worker |
| `WORKER_MAX_RSS_MB` | integer, 0 to 1048576 | `4096` | no | worker |
| `WORKER_DRAIN_TIMEOUT_MS` | integer, 0 to 2147483647 | `60000` | no | worker |
| `WORKER_HEARTBEAT_INTERVAL_MS` | integer, 1 to 2147483647 | `5000` | no | worker |
| `WORKER_HEARTBEAT_FILE` | file or directory path | worker-heartbeat.json in the operating system temporary directory | no | worker |
| `WORKER_HEARTBEAT_MAX_STALE_MS` | integer, 1 to 2147483647 | `35000` | no | worker |
| `CHECK_REDIS` | `true` or `false` | `true` | no | worker |
| `WORKER_QUEUES` | text | none | no | worker |
| `LIBREOFFICE_POOL_READINESS_TIMEOUT_MS` | integer, 5000 to 40000 | `30000` | no | worker |
| `JOB_STUCK_RECYCLE_MS` | integer, 1 to 2147483647 | `30000` | no | worker |

- `WORKER_CONCURRENCY`: Jobs a worker runs at once.
- `WORKER_MAX_JOBS`: Jobs after which the worker drains and exits so the container manager restarts it. `0` turns recycling by job count off.
- `WORKER_MAX_RSS_MB`: Resident memory in MiB above which the worker drains and exits after a job. `0` turns recycling by memory off.
- `WORKER_DRAIN_TIMEOUT_MS`: Milliseconds a draining worker waits for active jobs before it aborts them.
- `WORKER_HEARTBEAT_INTERVAL_MS`: Milliseconds between heartbeat file updates.
- `WORKER_HEARTBEAT_FILE`: File the worker writes its heartbeat to; the container health check reads it.
- `WORKER_HEARTBEAT_MAX_STALE_MS`: Age in milliseconds after which the container health check (scripts/worker-healthcheck.js) calls the heartbeat stale.
- `CHECK_REDIS`: Set to `false` to skip the Redis connection check of the container health check.
- `WORKER_QUEUES`: Comma-separated queues this worker takes jobs from (`default`, `light`, `cpu`, `memory`, `gpu`). All queues when unset.
- `LIBREOFFICE_POOL_READINESS_TIMEOUT_MS`: Milliseconds the LibreOffice pool waits for a worker process to become ready (5000 to 40000).
- `JOB_STUCK_RECYCLE_MS`: Milliseconds a conversion that ignored its abort at the job deadline may stay unfinished before the worker drains and exits to be restarted (a processor that does not look at its signal cannot be stopped otherwise). The aborted conversion keeps its concurrency slot until it finishes.

### Limits

| Variable | Type and rule | Default | Required in production | Process |
| --- | --- | --- | --- | --- |
| `MAX_IN_MEMORY_BYTES` | integer, at least 1 | `536870912` | no | web, worker |
| `GRAPH_URL_IMPORT_MAX_BYTES` | integer, at least 1 | `5368709120` | no | web, worker |
| `EASYCONVERT_MAX_INPUT_PIXELS` | integer, at least 1 | `100000000` | no | web, worker |
| `VIPS_CONCURRENCY` | integer, 1 to 2147483647 | 1 outside an encode; up to 8 (2 when MALLOC_ARENA_MAX is unset) during an AVIF encode or OCR page preparation | no | web, worker |
| `EASYCONVERT_PDF_TEXT_DEADLINE_MS` | integer, 1 to 2147483647 | `60000` | no | web, worker |
| `EASYCONVERT_OCR_PAGE_BUDGET_MS` | integer, 1 to 2147483647 | `10000` | no | web, worker |
| `EASYCONVERT_OCR_PAGE_CONCURRENCY` | integer, 1 to 2147483647 | `4` | no | web, worker |
| `JOB_DEADLINE_BASE_MS_FREE` | integer, 1 to 3600000 | `60000` | no | web, worker |
| `JOB_DEADLINE_BASE_MS_PRO` | integer, 1 to 3600000 | `120000` | no | web, worker |
| `JOB_DEADLINE_BASE_MS_ENTERPRISE` | integer, 1 to 3600000 | `180000` | no | web, worker |
| `JOB_DEADLINE_MAX_MS_FREE` | integer, 1 to 3600000 | `300000` | no | web, worker |
| `JOB_DEADLINE_MAX_MS_PRO` | integer, 1 to 3600000 | `1800000` | no | web, worker |
| `JOB_DEADLINE_MAX_MS_ENTERPRISE` | integer, 1 to 3600000 | `3600000` | no | web, worker |
| `JOB_DEADLINE_PER_MIB_MS` | integer, 1 to 2147483647 | `2000` | no | web, worker |
| `JOB_DEADLINE_PER_MEDIA_SECOND_MS` | integer, 1 to 2147483647 | `3000` | no | web, worker |
| `SYNC_DEADLINE_MAX_MS` | integer, 1 to 2147483647 | `120000` | no | web, worker |
| `CONVERSION_CONCURRENCY_FREE` | integer, 1 to 2147483647 | `5` | no | web, worker |
| `EASYCONVERT_XLS_MAX_GRID_CELLS` | integer, at least 1 | `4194304` | no | web, worker |
| `EASYCONVERT_XLS_MAX_PDF_TEXT_CELLS` | integer, at least 1 | `500000` | no | web, worker |
| `EASYCONVERT_XLS_MAX_CELL_TEXT_CHARS` | integer, at least 1 | `67108864` | no | web, worker |
| `EASYCONVERT_XLSX_MAX_CELL_TEXT_CHARS` | integer, at least 1 | `67108864` | no | web, worker |
| `EASYCONVERT_MAX_DOCUMENT_MEDIA_BYTES` | integer, at least 1 | `1073741824` | no | web, worker |
| `ANONYMOUS_DAILY_LIMIT` | integer, 1 to 2147483647 | `10` | no | web, worker |
| `ANONYMOUS_BURST_CAPACITY` | integer, 1 to 2147483647 | `10` | no | web |
| `ANONYMOUS_BURST_REFILL_RATE` | integer, 1 to 2147483647 | `1` | no | web |
| `ANONYMOUS_UNATTRIBUTED_BURST_CAPACITY` | integer, 1 to 2147483647 | `600` | no | web |
| `ANONYMOUS_UNATTRIBUTED_BURST_REFILL_RATE` | integer, 1 to 2147483647 | `100` | no | web |

- `MAX_IN_MEMORY_BYTES`: Largest stored object, in bytes, that may be read into memory instead of streamed.
- `GRAPH_URL_IMPORT_MAX_BYTES`: Largest body, in bytes, that an `import.url` graph node downloads.
- `EASYCONVERT_MAX_INPUT_PIXELS`: Largest declared canvas, in pixels, of a still-image input. A larger value is lowered to the built-in ceiling.
- `VIPS_CONCURRENCY`: Threads the image pipeline leases per operation. When unset, non-encode operations use 1 thread and AVIF encodes and OCR page preparations lease up to 8 threads (2 when MALLOC_ARENA_MAX is unset).
- `EASYCONVERT_PDF_TEXT_DEADLINE_MS`: Milliseconds the PDF text extraction may run before it is stopped.
- `EASYCONVERT_OCR_PAGE_BUDGET_MS`: Milliseconds of work the text recognition (OCR) of one page of a scanned PDF may cost. A document may take three page budgets plus one for each page it reads, so a long scan is never cut at a fixed time, and never more than 90 percent of the job's own deadline when it has one; a single page that takes six page budgets is refused too. A document or page over its limit is refused with HTTP 413.
- `EASYCONVERT_OCR_PAGE_CONCURRENCY`: Most pages of one scanned PDF that text recognition (OCR) prepares and recognizes at once, capped at the built-in per-document ceiling of 4 and the OCR worker pool size.
- `JOB_DEADLINE_BASE_MS_FREE`: Wall-clock milliseconds every conversion job of the free tier starts with, before the allowance for its media seconds and input size. A document does not use it: it gets the maximum of the tier. Must not exceed JOB_DEADLINE_MAX_MS_FREE.
- `JOB_DEADLINE_BASE_MS_PRO`: Wall-clock milliseconds every conversion job of the pro tier starts with, before the allowance for its media seconds and input size. A document does not use it: it gets the maximum of the tier. Must not exceed JOB_DEADLINE_MAX_MS_PRO.
- `JOB_DEADLINE_BASE_MS_ENTERPRISE`: Wall-clock milliseconds every conversion job of the enterprise tier starts with, before the allowance for its media seconds and input size. A document does not use it: it gets the maximum of the tier. Must not exceed JOB_DEADLINE_MAX_MS_ENTERPRISE.
- `JOB_DEADLINE_MAX_MS_FREE`: Most wall-clock milliseconds a conversion job of the free tier may run, the queue job timeout and the limit of the synchronous routes. A job past it is stopped, its processes are killed and it fails with JobTimeoutError (HTTP 504); work of unknown size, and a document (its pages are not known before it is converted), gets this value. At most one hour, since the sweep removes a job directory two hours after it was made.
- `JOB_DEADLINE_MAX_MS_PRO`: Most wall-clock milliseconds a conversion job of the pro tier may run, the queue job timeout and the limit of the synchronous routes. A job past it is stopped, its processes are killed and it fails with JobTimeoutError (HTTP 504); work of unknown size, and a document (its pages are not known before it is converted), gets this value. At most one hour, since the sweep removes a job directory two hours after it was made.
- `JOB_DEADLINE_MAX_MS_ENTERPRISE`: Most wall-clock milliseconds a conversion job of the enterprise tier may run, the queue job timeout and the limit of the synchronous routes. A job past it is stopped, its processes are killed and it fails with JobTimeoutError (HTTP 504); work of unknown size, and a document (its pages are not known before it is converted), gets this value. At most one hour, since the sweep removes a job directory two hours after it was made.
- `JOB_DEADLINE_PER_MIB_MS`: Milliseconds added to a job deadline for each started MiB of input.
- `JOB_DEADLINE_PER_MEDIA_SECOND_MS`: Milliseconds added to a job deadline for each second of audio or video, when the length is known.
- `SYNC_DEADLINE_MAX_MS`: Most wall-clock milliseconds a synchronous conversion request (`/api/convert`, `/api/v1/convert`, `/api/convert/batch`) may run, held below the job deadline of the tier. A request past it is stopped and answered with 504 and a pointer to the asynchronous API (`POST /api/v1/jobs`), which runs conversions up to the job deadline.
- `CONVERSION_CONCURRENCY_FREE`: Most conversions an anonymous or free-tier caller may have in flight at once, queued and running together, counted on the server. A request that would exceed it is answered 429 (problem type `concurrency-limit`, with `Retry-After`) and takes no quota. Paid tiers have no such limit.
- `EASYCONVERT_XLS_MAX_GRID_CELLS`: Most cells (rows x columns of the used range) of a legacy XLS sheet that an HTML, ODS or XLSX conversion expands to a grid in memory; a larger sheet is refused with HTTP 413. CSV, TSV and JSON are written row by row and are not limited by it.
- `EASYCONVERT_XLS_MAX_PDF_TEXT_CELLS`: Most cells holding text of a legacy XLS sheet that the in-process PDF writer lays out as a table (about 3 KB of memory per cell); a sheet with more is refused with HTTP 413. Blank cells are not counted.
- `EASYCONVERT_XLS_MAX_CELL_TEXT_CHARS`: Most characters the cells of a legacy XLS sheet may expand to for an HTML, ODS, XLSX or PDF conversion, shared strings counted once per cell that uses them; a sheet over it is refused with HTTP 413 (protects against one long shared string used by many cells).
- `EASYCONVERT_XLSX_MAX_CELL_TEXT_CHARS`: Most characters the cells of an XLSX workbook may expand to, shared strings counted once per cell that uses them; a workbook over it is refused with HTTP 413 (protects against one long shared string used by many cells).
- `EASYCONVERT_MAX_DOCUMENT_MEDIA_BYTES`: Most bytes of embedded media (pictures, video) one deck or document may decode to, each part counted once however many pictures use it; a document over it is refused with HTTP 413 (keeps the memory of a deck with large or repeated media within a job share).
- `ANONYMOUS_DAILY_LIMIT`: Conversions per day for an anonymous caller. In the OCI deployment it is the repository variable of the same name, which the web image build and the deploy both read (the deploy refuses an image built with another value).
- `ANONYMOUS_BURST_CAPACITY`: Token bucket size (largest burst of requests) of one anonymous caller.
- `ANONYMOUS_BURST_REFILL_RATE`: Requests per second that refill the token bucket of one anonymous caller.
- `ANONYMOUS_UNATTRIBUTED_BURST_CAPACITY`: Token bucket size shared by every anonymous caller whose address cannot be trusted.
- `ANONYMOUS_UNATTRIBUTED_BURST_REFILL_RATE`: Requests per second that refill the bucket shared by untrusted anonymous callers.

### Native tools

| Variable | Type and rule | Default | Required in production | Process |
| --- | --- | --- | --- | --- |
| `QPDF_RUNNER` | one of `auto`, `off` (any case) | `auto` | no | web, worker |
| `EASYCONVERT_OCR_ONNX` | one of `auto`, `off` (any case) | `auto` | no | web, worker |
| `FFMPEG_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `FFPROBE_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `FLUIDSYNTH_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `MIDI_SOUNDFONT_PATH` | file or directory path | none | no | web, worker |
| `AVIFENC_PATH` | absolute path of an executable (existence is not checked at start-up) | none | no | web, worker |
| `MAGICK_PATH` | absolute path of an executable (existence is not checked at start-up) | none | no | web, worker |
| `OPJ_DECOMPRESS_PATH` | absolute path of an executable (existence is not checked at start-up) | none | no | web, worker |
| `DJXL_PATH` | absolute path of an executable (existence is not checked at start-up) | none | no | web, worker |
| `MAGICK_POLICY_DIR` | file or directory path | none | no | web, worker |
| `P7ZIP_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `P7Z_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `ZIP_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `UNRAR_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `LBZIP2_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `LIBDEFLATE_GZIP_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `XZ_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `SOFFICE_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `PDFINFO_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `PDFTOPPM_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `PDFTOCAIRO_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `PDFTOTEXT_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `PDFTOPS_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `PS2PDF_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `GXPS_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `DDJVU_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `GS_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `DCRAW_EMU_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `DCRAW_EMU_HE_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `EBOOK_CONVERT_PATH` | absolute path of an executable (existence is not checked at start-up) | none | no | web, worker |
| `DWG2DXF_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `VTRACER_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `OXIPNG_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `VTRACER_PIXELS_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `CAD_CONVERT_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `PID_INIT_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `QPDF_RUNNER_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `QPDF_RUNNER_LIB` | file or directory path | none | no | web, worker |
| `FONTFORGE_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `RSVG_CONVERT_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `TESSERACT_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `TESSDATA_PREFIX` | file or directory path | none | no | web, worker |
| `EASYCONVERT_OCR_ONNX_DIR` | file or directory path | none | no | web, worker |
| `VERAPDF_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `QPDF_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `FC_LIST_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `JAVA_HOME` | file or directory path | none | no | web, worker |

- `QPDF_RUNNER`: Whether the qpdf jobs of the PDF operations run in a child of `qpdf-runner` (native/qpdf-runner) that has libqpdf loaded already, each in a user and network namespace of its own, instead of starting the `qpdf` program. `auto` (the default) uses the runner when it is installed and starts, and starts the program otherwise (and for any job the runner declines or cannot isolate). `off` always starts the program.
- `EASYCONVERT_OCR_ONNX`: Whether Korean pages (`kor`, `kor+eng`) are read by the ONNX OCR engine (PP-OCRv5 models in a sandboxed helper process, `src/lib/conversions/ocr-onnx-helper.ts`). `auto` (the default) uses it when the models, the `onnxruntime-node` package and the helper program are present, and reads Korean with Tesseract otherwise (the result carries `engineFallback`). `off` always reads Korean with Tesseract.
- `FFMPEG_PATH`: Path of the ffmpeg executable; searched in the standard locations when unset.
- `FFPROBE_PATH`: Path of the ffprobe executable.
- `FLUIDSYNTH_PATH`: Path of the FluidSynth `fluidsynth` executable that renders MIDI files to WAV; searched in the standard locations when unset.
- `MIDI_SOUNDFONT_PATH`: Path of the General MIDI SoundFont (`.sf2` or `.sf3`) handed to FluidSynth; searched in the standard locations when unset.
- `AVIFENC_PATH`: Absolute path of the libavif `avifenc` executable that encodes AVIF; searched in the standard locations when unset. The image library encodes when the tool is not installed, is not an executable file or is older than libavif 1.0.0; a value that is not an absolute path is rejected at start-up.
- `MAGICK_PATH`: Absolute path of the ImageMagick executable (`magick`, or `convert` of version 6) that decodes HEIC, HEIF, PSD, XCF, TGA, PCX, DDS, PNM and old-style JPEG TIFF pictures; searched in the standard locations when unset. Those conversions fail with HTTP 503 when the tool is not installed or is not an executable file; a value that is not an absolute path is rejected at start-up.
- `OPJ_DECOMPRESS_PATH`: Absolute path of the OpenJPEG `opj_decompress` executable that decodes JPEG 2000 (JP2, J2K) pictures; searched in the standard locations when unset. Those conversions fail with HTTP 503 when the tool is not installed or is not an executable file; a value that is not an absolute path is rejected at start-up.
- `DJXL_PATH`: Absolute path of the libjxl `djxl` executable that decodes JPEG XL (JXL) pictures; searched in the standard locations when unset. Those conversions fail with HTTP 503 when the tool is not installed or is not an executable file; a value that is not an absolute path is rejected at start-up.
- `MAGICK_POLICY_DIR`: Absolute path of the directory that holds the ImageMagick `policy.xml` every picture decode runs under (all coders and delegates denied except those the decoders use). Searched in `/etc/easyconvert/imagemagick` (the worker image) and `docker/imagemagick` (the repository) when unset; without a policy the conversions that need ImageMagick fail with HTTP 503.
- `P7ZIP_PATH`: Path of the 7-Zip executable (`7zz`, `7z` or `7za`).
- `P7Z_PATH`: Alternative name of P7ZIP_PATH for the archive code paths; used when P7ZIP_PATH is not set.
- `ZIP_PATH`: Path of the Info-ZIP `zip` executable.
- `UNRAR_PATH`: Path of the `unrar` executable.
- `LBZIP2_PATH`: Path of the `lbzip2` executable that compresses bzip2 streams of up to two blocks; searched in the standard locations when unset.
- `LIBDEFLATE_GZIP_PATH`: Path of the `libdeflate-gzip` executable that compresses raw deflate streams; searched in the standard locations when unset.
- `XZ_PATH`: Path of the `xz` executable that compresses and decompresses XZ streams; searched in the standard locations when unset.
- `SOFFICE_PATH`: Path of the LibreOffice `soffice` executable.
- `PDFINFO_PATH`: Path of the poppler `pdfinfo` executable.
- `PDFTOPPM_PATH`: Path of the poppler `pdftoppm` executable.
- `PDFTOCAIRO_PATH`: Path of the poppler `pdftocairo` executable.
- `PDFTOTEXT_PATH`: Path of the poppler `pdftotext` executable.
- `PDFTOPS_PATH`: Path of the poppler `pdftops` executable.
- `PS2PDF_PATH`: Path of the Ghostscript `ps2pdf` executable.
- `GXPS_PATH`: Path of the GhostXPS `gxps` executable that draws an XPS or OpenXPS document as a PDF; searched in the standard locations when unset. XPS to PDF and to page images cannot be converted without it (HTTP 503).
- `DDJVU_PATH`: Path of the djvulibre `ddjvu` executable that draws a DjVu document as a PDF; searched in the standard locations when unset. DjVu to PDF and to page images cannot be converted without it (HTTP 503).
- `GS_PATH`: Path of the Ghostscript `gs` executable that the PDF optimize operation runs.
- `DCRAW_EMU_PATH`: Path of the LibRaw `dcraw_emu` executable.
- `DCRAW_EMU_HE_PATH`: Path of the `dcraw_emu` of the pinned LibRaw snapshot (scripts/install-libraw-he.sh) that reads Nikon NEF files with High Efficiency or High Efficiency* compression; searched in the standard locations when unset. Without it such a file is refused with the words of the `dcraw_emu` of `DCRAW_EMU_PATH`; every other camera file never uses it.
- `EBOOK_CONVERT_PATH`: Absolute path of the calibre `ebook-convert` executable that writes MOBI, AZW3, PDB, LRF and OEB books; searched in the standard locations when unset. Those five formats cannot be written without it (HTTP 503); a value that is not an absolute path is rejected at start-up.
- `DWG2DXF_PATH`: Path of the LibreDWG `dwg2dxf` executable that reads a DWG drawing into a DXF; searched in the standard locations when unset. A DWG cannot be converted without it (HTTP 503).
- `VTRACER_PATH`: Path of the vtracer executable that traces PNG, JPEG, WebP, GIF, BMP and TIFF pictures to SVG; searched in the standard locations when unset. Those pictures cannot be converted to SVG without it (HTTP 503).
- `OXIPNG_PATH`: Path of the pinned oxipng executable that optimises a PNG converted to PNG without loss (entry 232); searched in the standard locations when unset. Without it the PNG is written as the image library encodes it.
- `VTRACER_PIXELS_PATH`: Path of the vtracer-pixels executable (scripts/vtracer-pixels), the vtracer front-end that reads the raw pixels the worker decoded; searched in the standard locations when unset. When it is found it traces those pictures instead of the vtracer executable; the SVG is the same.
- `CAD_CONVERT_PATH`: Path of the `cad-convert` executable (native/cad-convert, linked to the Open CASCADE libraries) that reads and writes STEP and IGES; searched in the standard locations when unset. A STEP or IGES file cannot be converted without it (HTTP 503).
- `PID_INIT_PATH`: Path of the `pid-init` executable (native/pid-init) that starts every sandboxed program in a PID namespace of its own, so that one run cannot see or signal another, and refuses them the /proc entries of the other runs (Landlock); searched in the standard locations when unset. Without it, or when the host does not allow a PID namespace, programs run in the user and network namespaces only.
- `QPDF_RUNNER_PATH`: Path of the `qpdf-runner` executable (native/qpdf-runner) that runs the qpdf jobs of the PDF operations from a process that holds libqpdf already loaded; searched in the standard locations when unset. Without it, or when it cannot start a job, every job runs the `qpdf` program as before.
- `QPDF_RUNNER_LIB`: Path of the libqpdf shared library handed to `qpdf-runner` (`--lib`); the runner loads the system libqpdf when unset.
- `FONTFORGE_PATH`: Path of the FontForge `fontforge` executable (fontforge-nox) that reads PostScript Type 1 fonts (PFA and PFB); searched in the standard locations when unset. A Type 1 font cannot be converted without it (HTTP 503).
- `RSVG_CONVERT_PATH`: Path of the librsvg `rsvg-convert` executable that writes an SVG as a vector PDF.
- `TESSERACT_PATH`: Path of the `tesseract` executable.
- `TESSDATA_PREFIX`: Directory of the Tesseract language data.
- `EASYCONVERT_OCR_ONNX_DIR`: Directory of the ONNX Korean OCR models (`det.onnx`, `rec.onnx`, `dict.txt`); `/opt/ocr-onnx` (the worker image) when unset. Installed by `scripts/install-onnx-ocr-models.sh`.
- `VERAPDF_PATH`: Path of the `verapdf` executable that validates PDF/A output.
- `QPDF_PATH`: Path of the `qpdf` executable that encrypts PDF output.
- `FC_LIST_PATH`: Path of the fontconfig `fc-list` executable.
- `JAVA_HOME`: Java installation handed to LibreOffice for PDF/A export.
