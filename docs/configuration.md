# Configuration

<!-- Generated from src/lib/config/schema.ts by `npm run config:docs`. Do not edit by hand. -->

EasyConvert reads 106 environment variables. The schema in `src/lib/config/schema.ts` declares each one with its type, default, production requirement and owning area; this page and `docs/configuration.example.env` are generated from it.

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

- `NODE_ENV`: Runtime mode. Only the value `production` switches on production start-up validation and production-only behaviour; any other value is treated as development.
- `NEXT_PHASE`: Set by Next.js. During `next build` (`phase-production-build`) production requirements are not enforced.
- `NEXT_RUNTIME`: Set by Next.js to `nodejs` or `edge`; the start-up hook runs only under `nodejs`.
- `PATH`: Directories searched for the native conversion tools and handed to sandboxed child processes.
- `KUBERNETES_SERVICE_HOST`: Set by Kubernetes. Any non-empty value marks the process as already container-isolated.
- `CONTAINER_SANDBOX`: Any non-empty value declares that the process already runs inside a container sandbox.

### Network and public URLs

| Variable | Type and rule | Default | Required in production | Process |
| --- | --- | --- | --- | --- |
| `APP_URL` | URL with the scheme `http` or `https` | `http://localhost:3000` (development only) | when `STORAGE_DRIVER` is `local` | web |
| `APP_ORIGIN` | URL with the scheme `http` or `https` | none | no | web |
| `NEXT_PUBLIC_APP_URL` | URL with the scheme `http` or `https` | none | no | web |

- `APP_URL`: Public origin of this application, used to build the URLs of local-driver uploads. Required in production when STORAGE_DRIVER is `local`.
- `APP_ORIGIN`: Canonical origin used for OAuth redirects and the same-origin check of the API; takes precedence over NEXT_PUBLIC_APP_URL.
- `NEXT_PUBLIC_APP_URL`: Public origin exposed to the browser; used when APP_ORIGIN is not set.

### Client address trust and sandbox

| Variable | Type and rule | Default | Required in production | Process |
| --- | --- | --- | --- | --- |
| `STRICT_SANDBOX` | `true` or `false` | `false` | no | web, worker |
| `TRUSTED_PROXIES` | comma-separated IPv4/IPv6 addresses or CIDR ranges or `none`, at most 256 entries | none | no | web |
| `TRUSTED_CDN` | one of `cloudflare` (any case) | none | no | web |
| `TRUSTED_CDN_RANGES` | comma-separated IPv4/IPv6 addresses or CIDR ranges, at most 256 entries | none | no | web |
| `TRUSTED_PROXY_HEADER` | one of `x-forwarded-for`, `forwarded` (any case) | none | no | web |

- `STRICT_SANDBOX`: Set to `true` to refuse running native tools without the strict process sandbox.
- `TRUSTED_PROXIES`: Comma-separated IPv4/IPv6 addresses or CIDR ranges of the reverse proxies in front of the server, or `none` for a directly exposed server. Production should declare one of TRUSTED_PROXIES or TRUSTED_CDN; the edge middleware answers API requests with 503 until it does (docs/client-ip-trust.md).
- `TRUSTED_CDN`: Name of the CDN whose edge ranges are trusted to forward client addresses.
- `TRUSTED_CDN_RANGES`: CIDR ranges that replace the built-in edge ranges of TRUSTED_CDN.
- `TRUSTED_PROXY_HEADER`: The one forwarding header the trusted proxy writes: `x-forwarded-for` (default) or `forwarded`.

### Sign-in

| Variable | Type and rule | Default | Required in production | Process |
| --- | --- | --- | --- | --- |
| `JWT_SECRET` | secret, at least 32 bytes of UTF-8 text in production (the text is measured, never decoded); secret, never logged | none | yes | web |
| `GOOGLE_CLIENT_ID` | text | none | no | web |
| `GOOGLE_CLIENT_SECRET` | secret text; secret, never logged | none | no | web |

- `JWT_SECRET`: Signs session tokens. At least 32 bytes of UTF-8 text in production; also the last fallback key of the credential vault and of API key secret encryption.
- `GOOGLE_CLIENT_ID`: OAuth client id for Google sign-in. Without it, development uses a local mock sign-in and production refuses to sign in.
- `GOOGLE_CLIENT_SECRET`: OAuth client secret for Google sign-in; required together with GOOGLE_CLIENT_ID.

### Keys and secrets

| Variable | Type and rule | Default | Required in production | Process |
| --- | --- | --- | --- | --- |
| `KEY_HASH_PEPPER` | secret, at least 32 bytes of UTF-8 text in production (the text is measured, never decoded); secret, never logged | none | yes | web |
| `KEY_ENCRYPTION_KEY` | secret, at least 32 bytes of UTF-8 text in production (the text is measured, never decoded); secret, never logged | none | no | web, worker |
| `WEBHOOK_SECRET_KEK` | secret, at least 32 bytes of UTF-8 text in production (the text is measured, never decoded); secret, never logged | none | yes | web |
| `STORAGE_VAULT_KEY` | secret, at least 32 bytes of UTF-8 text in production (the text is measured, never decoded); secret, never logged | none | no | web, worker |
| `JOB_SECRET_KEK` | secret, at least 32 bytes of UTF-8 text in production (the text is measured, never decoded), no surrounding whitespace in production; secret, never logged | none | yes | web, worker |
| `JOB_SECRET_KEK_PREVIOUS` | secret, at least 32 bytes of UTF-8 text in production (the text is measured, never decoded), no surrounding whitespace in production; secret, never logged | none | no | web, worker |

- `KEY_HASH_PEPPER`: Pepper of the HMAC that hashes API key secrets. At least 32 bytes of UTF-8 text in production. Also the second fallback key of API key secret encryption.
- `KEY_ENCRYPTION_KEY`: Key that encrypts API key webhook secrets at rest; falls back to KEY_HASH_PEPPER, then JWT_SECRET. Also the second fallback key of the credential vault.
- `WEBHOOK_SECRET_KEK`: Key-encryption key of the webhook signing secrets. At least 32 bytes of UTF-8 text in production. The worker dispatches webhooks and needs it too once the deployment sends them.
- `STORAGE_VAULT_KEY`: Master key of the vault that holds customer storage credentials; falls back to KEY_ENCRYPTION_KEY, then JWT_SECRET.
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
| `BYOS_S3_DEV_ENDPOINT_ALLOWLIST` | text | none | no | web, worker |

- `STORAGE_DRIVER`: Where objects live: `oci` (OCI Object Storage), `s3` (an S3-compatible service) or `local` (disk of this host, for development and single-node use). Must be chosen in production.
- `STORAGE_SIGNING_SECRET`: Signs upload and download URLs. At least 32 bytes of UTF-8 text in production (surrounding whitespace is trimmed). One of STORAGE_SIGNING_SECRET, S3_SIGNING_SECRET or OCI_SIGNING_SECRET is required in production; the first one set wins.
- `S3_SIGNING_SECRET`: Alternative name of STORAGE_SIGNING_SECRET; used when STORAGE_SIGNING_SECRET is not set.
- `OCI_SIGNING_SECRET`: Alternative name of STORAGE_SIGNING_SECRET; used when neither STORAGE_SIGNING_SECRET nor S3_SIGNING_SECRET is set.
- `EASYCONVERT_STORAGE_DIR`: Directory of the local storage driver and of the API key, usage and file stores. Share it between the API and the workers.
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

### Limits

| Variable | Type and rule | Default | Required in production | Process |
| --- | --- | --- | --- | --- |
| `MAX_IN_MEMORY_BYTES` | integer, at least 1 | `536870912` | no | web, worker |
| `GRAPH_URL_IMPORT_MAX_BYTES` | integer, at least 1 | `5368709120` | no | web, worker |
| `EASYCONVERT_MAX_INPUT_PIXELS` | integer, at least 1 | `100000000` | no | web, worker |
| `EASYCONVERT_PDF_TEXT_DEADLINE_MS` | integer, 1 to 2147483647 | `60000` | no | web, worker |
| `JOB_DEADLINE_BASE_MS_FREE` | integer, 1 to 2147483647 | `60000` | no | web, worker |
| `JOB_DEADLINE_BASE_MS_PRO` | integer, 1 to 2147483647 | `120000` | no | web, worker |
| `JOB_DEADLINE_BASE_MS_ENTERPRISE` | integer, 1 to 2147483647 | `180000` | no | web, worker |
| `JOB_DEADLINE_MAX_MS_FREE` | integer, 1 to 2147483647 | `600000` | no | web, worker |
| `JOB_DEADLINE_MAX_MS_PRO` | integer, 1 to 2147483647 | `1800000` | no | web, worker |
| `JOB_DEADLINE_MAX_MS_ENTERPRISE` | integer, 1 to 2147483647 | `3600000` | no | web, worker |
| `JOB_DEADLINE_PER_PAGE_MS` | integer, 1 to 2147483647 | `10000` | no | web, worker |
| `JOB_DEADLINE_PER_MIB_MS` | integer, 1 to 2147483647 | `2000` | no | web, worker |
| `JOB_DEADLINE_PER_MEDIA_SECOND_MS` | integer, 1 to 2147483647 | `3000` | no | web, worker |
| `EASYCONVERT_XLS_MAX_GRID_CELLS` | integer, at least 1 | `4194304` | no | web, worker |
| `EASYCONVERT_XLS_MAX_PDF_TEXT_CELLS` | integer, at least 1 | `500000` | no | web, worker |
| `EASYCONVERT_XLS_MAX_CELL_TEXT_CHARS` | integer, at least 1 | `67108864` | no | web, worker |
| `EASYCONVERT_XLSX_MAX_CELL_TEXT_CHARS` | integer, at least 1 | `67108864` | no | web, worker |
| `ANONYMOUS_DAILY_LIMIT` | integer, 1 to 2147483647 | `10` | no | web |
| `ANONYMOUS_BURST_CAPACITY` | integer, 1 to 2147483647 | `10` | no | web |
| `ANONYMOUS_BURST_REFILL_RATE` | integer, 1 to 2147483647 | `1` | no | web |
| `ANONYMOUS_UNATTRIBUTED_BURST_CAPACITY` | integer, 1 to 2147483647 | `600` | no | web |
| `ANONYMOUS_UNATTRIBUTED_BURST_REFILL_RATE` | integer, 1 to 2147483647 | `100` | no | web |

- `MAX_IN_MEMORY_BYTES`: Largest stored object, in bytes, that may be read into memory instead of streamed.
- `GRAPH_URL_IMPORT_MAX_BYTES`: Largest body, in bytes, that an `import.url` graph node downloads.
- `EASYCONVERT_MAX_INPUT_PIXELS`: Largest declared canvas, in pixels, of a still-image input. A larger value is lowered to the built-in ceiling.
- `EASYCONVERT_PDF_TEXT_DEADLINE_MS`: Milliseconds the PDF text extraction may run before it is stopped.
- `JOB_DEADLINE_BASE_MS_FREE`: Wall-clock milliseconds every conversion job of the free tier starts with, before the allowance for its pages, media seconds and input size. Must not exceed JOB_DEADLINE_MAX_MS_FREE.
- `JOB_DEADLINE_BASE_MS_PRO`: Wall-clock milliseconds every conversion job of the pro tier starts with, before the allowance for its pages, media seconds and input size. Must not exceed JOB_DEADLINE_MAX_MS_PRO.
- `JOB_DEADLINE_BASE_MS_ENTERPRISE`: Wall-clock milliseconds every conversion job of the enterprise tier starts with, before the allowance for its pages, media seconds and input size. Must not exceed JOB_DEADLINE_MAX_MS_ENTERPRISE.
- `JOB_DEADLINE_MAX_MS_FREE`: Most wall-clock milliseconds a conversion job of the free tier may run, the queue job timeout and the limit of the synchronous routes. A job past it is stopped, its processes are killed and it fails with JobTimeoutError (HTTP 504); work of unknown size gets this value.
- `JOB_DEADLINE_MAX_MS_PRO`: Most wall-clock milliseconds a conversion job of the pro tier may run, the queue job timeout and the limit of the synchronous routes. A job past it is stopped, its processes are killed and it fails with JobTimeoutError (HTTP 504); work of unknown size gets this value.
- `JOB_DEADLINE_MAX_MS_ENTERPRISE`: Most wall-clock milliseconds a conversion job of the enterprise tier may run, the queue job timeout and the limit of the synchronous routes. A job past it is stopped, its processes are killed and it fails with JobTimeoutError (HTTP 504); work of unknown size gets this value.
- `JOB_DEADLINE_PER_PAGE_MS`: Milliseconds added to a job deadline for each page of a document (the page limit of the tier when the count is unknown). The default is the OCR page budget.
- `JOB_DEADLINE_PER_MIB_MS`: Milliseconds added to a job deadline for each started MiB of input.
- `JOB_DEADLINE_PER_MEDIA_SECOND_MS`: Milliseconds added to a job deadline for each second of audio or video, when the length is known.
- `EASYCONVERT_XLS_MAX_GRID_CELLS`: Most cells (rows x columns of the used range) of a legacy XLS sheet that an HTML, ODS or XLSX conversion expands to a grid in memory; a larger sheet is refused with HTTP 413. CSV, TSV and JSON are written row by row and are not limited by it.
- `EASYCONVERT_XLS_MAX_PDF_TEXT_CELLS`: Most cells holding text of a legacy XLS sheet that the in-process PDF writer lays out as a table (about 3 KB of memory per cell); a sheet with more is refused with HTTP 413. Blank cells are not counted.
- `EASYCONVERT_XLS_MAX_CELL_TEXT_CHARS`: Most characters the cells of a legacy XLS sheet may expand to for an HTML, ODS, XLSX or PDF conversion, shared strings counted once per cell that uses them; a sheet over it is refused with HTTP 413 (protects against one long shared string used by many cells).
- `EASYCONVERT_XLSX_MAX_CELL_TEXT_CHARS`: Most characters the cells of an XLSX workbook may expand to, shared strings counted once per cell that uses them; a workbook over it is refused with HTTP 413 (protects against one long shared string used by many cells).
- `ANONYMOUS_DAILY_LIMIT`: Conversions per day for an anonymous caller.
- `ANONYMOUS_BURST_CAPACITY`: Token bucket size (largest burst of requests) of one anonymous caller.
- `ANONYMOUS_BURST_REFILL_RATE`: Requests per second that refill the token bucket of one anonymous caller.
- `ANONYMOUS_UNATTRIBUTED_BURST_CAPACITY`: Token bucket size shared by every anonymous caller whose address cannot be trusted.
- `ANONYMOUS_UNATTRIBUTED_BURST_REFILL_RATE`: Requests per second that refill the bucket shared by untrusted anonymous callers.

### Native tools

| Variable | Type and rule | Default | Required in production | Process |
| --- | --- | --- | --- | --- |
| `FFMPEG_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `FFPROBE_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `AVIFENC_PATH` | absolute path of an executable (existence is not checked at start-up) | none | no | web, worker |
| `P7ZIP_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `P7Z_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `ZIP_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `UNRAR_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `SOFFICE_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `PDFINFO_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `PDFTOPPM_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `PDFTOCAIRO_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `PDFTOTEXT_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `PDFTOPS_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `PS2PDF_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `DCRAW_EMU_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `TESSERACT_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `TESSDATA_PREFIX` | file or directory path | none | no | web, worker |
| `VERAPDF_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `QPDF_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `FC_LIST_PATH` | path or command name of an executable (existence is not checked at start-up) | none | no | web, worker |
| `JAVA_HOME` | file or directory path | none | no | web, worker |

- `FFMPEG_PATH`: Path of the ffmpeg executable; searched in the standard locations when unset.
- `FFPROBE_PATH`: Path of the ffprobe executable.
- `AVIFENC_PATH`: Absolute path of the libavif `avifenc` executable that encodes AVIF; searched in the standard locations when unset. The image library encodes when the tool is not installed, is not an executable file or is older than libavif 1.0.0; a value that is not an absolute path is rejected at start-up.
- `P7ZIP_PATH`: Path of the 7-Zip executable (`7zz`, `7z` or `7za`).
- `P7Z_PATH`: Alternative name of P7ZIP_PATH for the archive code paths; used when P7ZIP_PATH is not set.
- `ZIP_PATH`: Path of the Info-ZIP `zip` executable.
- `UNRAR_PATH`: Path of the `unrar` executable.
- `SOFFICE_PATH`: Path of the LibreOffice `soffice` executable.
- `PDFINFO_PATH`: Path of the poppler `pdfinfo` executable.
- `PDFTOPPM_PATH`: Path of the poppler `pdftoppm` executable.
- `PDFTOCAIRO_PATH`: Path of the poppler `pdftocairo` executable.
- `PDFTOTEXT_PATH`: Path of the poppler `pdftotext` executable.
- `PDFTOPS_PATH`: Path of the poppler `pdftops` executable.
- `PS2PDF_PATH`: Path of the Ghostscript `ps2pdf` executable.
- `DCRAW_EMU_PATH`: Path of the LibRaw `dcraw_emu` executable.
- `TESSERACT_PATH`: Path of the `tesseract` executable.
- `TESSDATA_PREFIX`: Directory of the Tesseract language data.
- `VERAPDF_PATH`: Path of the `verapdf` executable that validates PDF/A output.
- `QPDF_PATH`: Path of the `qpdf` executable that encrypts PDF output.
- `FC_LIST_PATH`: Path of the fontconfig `fc-list` executable.
- `JAVA_HOME`: Java installation handed to LibreOffice for PDF/A export.

### Page

| Variable | Type and rule | Default | Required in production | Process |
| --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_ADSENSE_CLIENT` | text | none | no | web |
| `NEXT_PUBLIC_ADSENSE_SLOT` | text | none | no | web |

- `NEXT_PUBLIC_ADSENSE_CLIENT`: Ad network publisher id shown in the page banner; no ads are rendered without it.
- `NEXT_PUBLIC_ADSENSE_SLOT`: Ad slot id of the page banner.
