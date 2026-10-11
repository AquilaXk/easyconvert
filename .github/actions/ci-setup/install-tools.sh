#!/usr/bin/env bash
# Sets up the test tools of one CI job. The parts do not depend on each other, so they run at once and the step
# lasts as long as the slowest one (the package install) instead of the sum of all of them:
#   apt      conversion and oracle CLIs, from the cached .deb files when the cache was restored
#   pip      the Python format oracles
#   verapdf  the PDF/A validator, from the cached install when the cache was restored
#   epubcheck the EPUB validator, from its release archive checked against a pinned SHA-256
#   calibre   the ebook converter the ebook benchmark compares against, from its release archive checked against a pinned SHA-256
#   raw      the RAW sample files
#   s3       the S3 test server and its bucket, only for a job that runs the real-server storage tests
# Every part runs under `timeout` with its own limit, so a part that hangs fails the step by name once its limit has
# passed, long before the job timeout. Each part logs to its own file; the logs are printed in groups afterwards, a
# failed or stopped part is printed in full outside a group, and a cancelled job prints them as well.
#
# Environment: ACTION_PATH, APT_DEBS, APT_CACHE_HIT, VERAPDF_CACHE_HIT and S3_TEST_SERVER (true or false). With
# S3_TEST_SERVER=true also S3_IMAGE_CACHE_DIR and the STORAGE_TEST_S3_* variables of the job.
#
# Sourcing the file defines the functions and runs nothing, which is how the tests exercise the limits.
set -uo pipefail

# Limits and pins. Exported so that the tasks, which run in a `timeout bash -c` of their own, see them.
set -a
# Seconds `timeout` waits after the termination signal before it kills a task that is still running.
KILL_GRACE_SECONDS=10
# The S3 test server: a pull is retried a few times, because anonymous registry pulls are rate limited, and every
# wait is counted, so the worst case of the task is the sum of these and fits its limit.
S3_PULL_ATTEMPTS=3
S3_PULL_TIMEOUT_SECONDS=45
S3_PULL_BACKOFF_SECONDS=10
S3_RUN_TIMEOUT_SECONDS=30
S3_HEALTH_ATTEMPTS=20
S3_HEALTH_INTERVAL_SECONDS=2
S3_HEALTH_CURL_TIMEOUT_SECONDS=3
S3_SIGV4_CURL_TIMEOUT_SECONDS=10
# The image is tagged locally after the pull, because `docker save` of an image that was pulled by digest keeps no name.
S3_LOCAL_IMAGE_TAG=easyconvert-s3-test-server:pinned
EPUBCHECK_VERSION=5.2.1
EPUBCHECK_SHA256=0532f6291faa2bb729dd253f958868a2a57dbd2c32f881a97c7c980c5940309e
CALIBRE_VERSION=9.15.0
CALIBRE_SHA256=3f5301c0aa51e5fb2d5f6dcd04024ba4e86501ab328ce5d9d6760efccb887990
set +a

# Seconds each task may run. The whole step of a job took 119 s at most over the last 64 successful runs, with the
# package install the slowest part; a limit is two to three times what a part can need, and the longest one, s3,
# covers its counted worst case (315 s: 165 pull, 30 start, 100 wait, 20 signature checks). The job timeout is
# 15 minutes, so the step never leaves a job less than nine.
declare -A task_limit_seconds=(
  [apt]=300
  [pip]=180
  [verapdf]=240
  [epubcheck]=120
  [calibre]=240
  [raw]=240
  [s3]=360
)

# Reads the settings of the job. A switch that is not exactly true or false, or a missing setting of a job that starts
# the S3 test server, stops the step before any task starts.
configure() {
  export action_path="${ACTION_PATH:?ACTION_PATH}"
  export apt_debs="${APT_DEBS:?APT_DEBS}"
  export apt_cache_hit="${APT_CACHE_HIT:-false}"
  export verapdf_cache_hit="${VERAPDF_CACHE_HIT:-false}"
  export verapdf_dir=/opt/verapdf
  s3_test_server="${S3_TEST_SERVER-}"
  case "$s3_test_server" in
    false) ;;
    true)
      : "${STORAGE_TEST_S3_ENDPOINT:?STORAGE_TEST_S3_ENDPOINT}"
      : "${STORAGE_TEST_S3_ACCESS_KEY_ID:?STORAGE_TEST_S3_ACCESS_KEY_ID}"
      : "${STORAGE_TEST_S3_SECRET_ACCESS_KEY:?STORAGE_TEST_S3_SECRET_ACCESS_KEY}"
      : "${STORAGE_TEST_S3_BUCKET:?STORAGE_TEST_S3_BUCKET}"
      export S3_IMAGE_CACHE_DIR="${S3_IMAGE_CACHE_DIR:?S3_IMAGE_CACHE_DIR}"
      # The pin lives in one file, which is also the key of the image cache. It must name the image by digest.
      S3_TEST_SERVER_IMAGE="$(tr -d '[:space:]' < "$action_path/s3-test-server-image.txt")"
      if [[ ! "$S3_TEST_SERVER_IMAGE" =~ ^[a-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$ ]]; then
        echo "$action_path/s3-test-server-image.txt must hold one image reference pinned by digest, got '$S3_TEST_SERVER_IMAGE'" >&2
        exit 1
      fi
      export S3_TEST_SERVER_IMAGE
      ;;
    *)
      echo "S3_TEST_SERVER must be true or false, got '$s3_test_server'" >&2
      exit 1
      ;;
  esac
}

# The tasks of this job; the S3 test server only when the job runs tests that read it.
select_tasks() {
  tasks=(apt pip verapdf epubcheck calibre raw)
  if [ "$s3_test_server" = true ]; then
    tasks+=(s3)
  fi
}

# Python format oracles (columnar readers, PDF text extraction, Word, Excel, EPUB and OLE2 readers): the tests run python3 -I, which ignores user
# site-packages, so the pinned packages go to the system interpreter.
# --ignore-installed: the image ships an older distro PyMuPDF that pip cannot uninstall. Test-only; nothing ships.
task_pip() {
  sudo python3 -m pip install --no-cache-dir --break-system-packages --ignore-installed pyarrow==25.0.1 duckdb==1.5.6 pymupdf==1.28.2 \
    python-docx==1.2.0 openpyxl==3.1.5 ebooklib==0.20 olefile==0.47
}

task_apt() {
  "$action_path/install-apt-tools.sh" "$apt_debs" "$action_path/apt-packages.txt" "$apt_cache_hit" || return 1
  # Pre-stage Tesseract traineddata assets for offline inference
  find /usr/share/tesseract-ocr /usr/share/tessdata -name "*.traineddata" -exec cp -u {} ./ \; 2>/dev/null || true
}

# PDF/A results are refused unless veraPDF validates them.
task_verapdf() {
  if [ "$verapdf_cache_hit" = true ] && [ -x "$verapdf_dir/verapdf" ]; then
    sudo ln -sf "$verapdf_dir/verapdf" /usr/local/bin/verapdf
    verapdf --version
  else
    sudo scripts/install-verapdf.sh "$verapdf_dir"
  fi
}

# EPUB outputs are checked by the EPUB validator; the archive is checked before anything in it runs.
task_epubcheck() {
  local archive dir
  archive="$(mktemp --suffix=.zip)"
  dir=/opt/epubcheck
  curl -fsSL --proto =https --proto-redir =https --retry 3 -o "$archive" "https://github.com/w3c/epubcheck/releases/download/v$EPUBCHECK_VERSION/epubcheck-$EPUBCHECK_VERSION.zip" || return 1
  echo "$EPUBCHECK_SHA256  $archive" | sha256sum -c - || return 1
  sudo rm -rf "$dir" && sudo mkdir -p "$dir" && sudo unzip -q "$archive" -d "$dir" || return 1
  printf '#!/bin/sh\nexec java -Djava.awt.headless=true -jar %s/epubcheck-%s/epubcheck.jar "$@"\n' "$dir" "$EPUBCHECK_VERSION" | sudo tee /usr/local/bin/epubcheck > /dev/null
  sudo chmod 755 /usr/local/bin/epubcheck
  epubcheck --version
}

# Ebook conversions are compared with calibre's `ebook-convert` (GPL-3.0, run as a separate process). The release archive carries
# its own Python and Qt, so the system Python packages that the oracles install cannot shadow its libraries; it is checked
# before anything in it runs.
task_calibre() {
  local archive dir
  archive="$(mktemp --suffix=.txz)"
  dir=/opt/calibre
  curl -fsSL --proto =https --proto-redir =https --retry 3 -o "$archive" "https://download.calibre-ebook.com/$CALIBRE_VERSION/calibre-$CALIBRE_VERSION-x86_64.txz" || return 1
  echo "$CALIBRE_SHA256  $archive" | sha256sum -c - || return 1
  sudo rm -rf "$dir" && sudo mkdir -p "$dir" && sudo tar -xJf "$archive" -C "$dir" || return 1
  rm -f "$archive"
  sudo ln -sf "$dir/ebook-convert" /usr/local/bin/ebook-convert
  ebook-convert --version
}

task_raw() {
  npm run fixtures:raw
}

# Pulls the pinned image, trying a bounded number of times: anonymous registry pulls are rate limited.
s3_pull_image() {
  local attempt
  for ((attempt = 1; attempt <= S3_PULL_ATTEMPTS; attempt++)); do
    if timeout "${S3_PULL_TIMEOUT_SECONDS}s" docker pull "$S3_TEST_SERVER_IMAGE"; then
      return 0
    fi
    if [ "$attempt" -lt "$S3_PULL_ATTEMPTS" ]; then
      sleep $((attempt * S3_PULL_BACKOFF_SECONDS))
    fi
  done
  echo "could not pull $S3_TEST_SERVER_IMAGE after $S3_PULL_ATTEMPTS attempts" >&2
  return 1
}

# Leaves the pinned image available under the local tag. The cache directory is keyed on the pinned digest, so a
# tarball in it is that image; its checksum guards against a truncated file, and an unusable tarball is replaced by
# a fresh pull. The cache action saves the directory only after a job that had to pull, and only when the job succeeds.
s3_obtain_image() {
  local tarball="$S3_IMAGE_CACHE_DIR/image.tar" checksum=image.tar.sha256
  if [ -f "$tarball" ] && [ -f "$S3_IMAGE_CACHE_DIR/$checksum" ]; then
    if (cd "$S3_IMAGE_CACHE_DIR" && sha256sum --check --strict "$checksum") &&
      docker load -i "$tarball" && docker image inspect "$S3_LOCAL_IMAGE_TAG" > /dev/null; then
      echo "loaded $S3_TEST_SERVER_IMAGE from the cached image"
      return 0
    fi
    echo "the cached image is unusable; pulling it again"
  fi
  rm -rf "$S3_IMAGE_CACHE_DIR" && mkdir -p "$S3_IMAGE_CACHE_DIR" || return 1
  s3_pull_image || return 1
  docker tag "$S3_TEST_SERVER_IMAGE" "$S3_LOCAL_IMAGE_TAG" || return 1
  docker save -o "$tarball.partial" "$S3_LOCAL_IMAGE_TAG" || return 1
  mv "$tarball.partial" "$tarball" && (cd "$S3_IMAGE_CACHE_DIR" && sha256sum image.tar > "$checksum")
}

s3_wait_live() {
  local attempt
  for ((attempt = 1; attempt <= S3_HEALTH_ATTEMPTS; attempt++)); do
    if curl -fsS --max-time "$S3_HEALTH_CURL_TIMEOUT_SECONDS" "$STORAGE_TEST_S3_ENDPOINT/minio/health/live" > /dev/null; then
      return 0
    fi
    sleep "$S3_HEALTH_INTERVAL_SECONDS"
  done
  echo "S3 test server did not become live after $S3_HEALTH_ATTEMPTS attempts" >&2
  docker logs s3-test-server >&2
  return 1
}

# curl signs both requests with its own SigV4 implementation. The wrong secret must be refused, otherwise the
# server would not enforce signatures and the client tests could not catch a signing bug.
s3_sign() {
  local empty_sha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
  curl -sS --max-time "$S3_SIGV4_CURL_TIMEOUT_SECONDS" -o /dev/null -w '%{http_code}' -X PUT \
    --user "$STORAGE_TEST_S3_ACCESS_KEY_ID:$1" --aws-sigv4 "aws:amz:us-east-1:s3" \
    -H "x-amz-content-sha256: $empty_sha256" "$STORAGE_TEST_S3_ENDPOINT/$2"
}

s3_check_signatures() {
  local refused created
  refused=$(s3_sign "wrong-$STORAGE_TEST_S3_SECRET_ACCESS_KEY" signature-check)
  if [ "$refused" != 403 ]; then
    echo "expected 403 for a request signed with a wrong secret, got $refused" >&2
    return 1
  fi
  created=$(s3_sign "$STORAGE_TEST_S3_SECRET_ACCESS_KEY" "$STORAGE_TEST_S3_BUCKET")
  if [ "$created" != 200 ]; then
    echo "expected 200 creating $STORAGE_TEST_S3_BUCKET, got $created" >&2
    docker logs s3-test-server >&2
    return 1
  fi
}

# Real-server leg of the S3 storage tests, which read STORAGE_TEST_S3_*: a server this repository did not write,
# which verifies SigV4 itself. It is started with `docker run` because a service container cannot pass
# `server /data`. The image is pinned by digest in s3-test-server-image.txt; move the pin if that image repository
# is removed.
task_s3() {
  s3_obtain_image || return 1
  timeout "${S3_RUN_TIMEOUT_SECONDS}s" docker run -d --name s3-test-server -p 127.0.0.1:9000:9000 \
    -e MINIO_ROOT_USER="$STORAGE_TEST_S3_ACCESS_KEY_ID" \
    -e MINIO_ROOT_PASSWORD="$STORAGE_TEST_S3_SECRET_ACCESS_KEY" \
    "$S3_LOCAL_IMAGE_TAG" || return 1
  s3_wait_live || return 1
  s3_check_signatures
}

# Each task runs in a `bash -c` of its own under `timeout`, which signals the whole process group of the task when
# the limit passes and kills what is left after the grace period. The task functions are exported for that shell.
export -f task_pip task_apt task_verapdf task_epubcheck task_calibre task_raw task_s3 s3_pull_image s3_obtain_image s3_wait_live s3_sign s3_check_signatures

# Runs one task and ends its log with what happened to it and how long it took.
run_bounded() {
  local task="$1" started="$SECONDS" status
  timeout --kill-after="${KILL_GRACE_SECONDS}s" "${task_limit_seconds[$task]}s" bash -uo pipefail -c "task_$task"
  status=$?
  if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
    echo "task $task exceeded its limit of ${task_limit_seconds[$task]}s and was stopped"
  elif [ "$status" -ne 0 ]; then
    echo "task $task failed with status $status"
  fi
  echo "task $task finished with status $status after $((SECONDS - started))s"
  return "$status"
}

# A cancelled job (the job timeout, a newer push) sends a termination signal to the step: show what every task had
# logged so far, which is otherwise lost with the runner, then stop what is still running.
on_interrupt() {
  trap - INT TERM
  echo "::error::tool setup interrupted before it finished; the logs so far follow"
  local task pid
  for task in "${tasks[@]}"; do
    echo "::group::$task (interrupted)"
    cat "$task_logs/$task.log"
    echo "::endgroup::"
  done
  for task in "${tasks[@]}"; do
    pid="${task_pids[$task]:-}"
    if [ -n "$pid" ]; then
      pkill -TERM -P "$pid" 2> /dev/null || true
    fi
  done
  exit 143
}

# Starts every task of `tasks` at once, waits for all of them and prints their logs. Returns 1 when any failed.
run_tasks() {
  local task
  local -a failed=()
  for task in "${tasks[@]}"; do
    if [ -z "${task_limit_seconds[$task]:-}" ]; then
      echo "::error::no time limit for task $task"
      return 1
    fi
  done

  task_logs="$(mktemp -d)"
  declare -gA task_pids=()
  trap on_interrupt INT TERM
  for task in "${tasks[@]}"; do
    run_bounded "$task" > "$task_logs/$task.log" 2>&1 &
    task_pids[$task]=$!
  done

  for task in "${tasks[@]}"; do
    if wait "${task_pids[$task]}"; then
      echo "::group::$task (ok)"
      cat "$task_logs/$task.log"
      echo "::endgroup::"
    else
      failed+=("$task")
      echo "::error::task $task failed; its log follows"
      cat "$task_logs/$task.log"
    fi
  done
  trap - INT TERM
  rm -rf "$task_logs"

  if [ "${#failed[@]}" -gt 0 ]; then
    echo "::error::tool setup failed: ${failed[*]}"
    return 1
  fi
}

main() {
  configure
  select_tasks
  run_tasks
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
