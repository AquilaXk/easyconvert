#!/usr/bin/env bash
# Sets up the test tools of one CI job. The parts do not depend on each other, so they run at once and the step
# lasts as long as the slowest one (the package install) instead of the sum of all of them:
#   apt      conversion and oracle CLIs, from the cached .deb files when the cache was restored, and cad-convert (the STEP and IGES
#            program, native/cad-convert) built against the Open CASCADE development packages of the same list
#   pip      the Python format oracles
#   verapdf  the PDF/A validator, from the cached install when the cache was restored
#   epubcheck the EPUB validator, from its release archive checked against a pinned SHA-256
#   calibre   the ebook converter the ebook benchmark compares against and the writer of the MOBI, AZW3, PDB, LRF and OEB tests, from its release archive checked against a pinned SHA-256
#   libredwg the DWG reader (dwg2dxf), built from its release archive checked against a pinned SHA-256, or the cached build
#   ghostxps the XPS renderer (gxps), built from the GhostPDL release archive checked against a pinned SHA-256, or the cached build when its digest still matches
#   raw      the RAW sample files
#   s3       the S3 test server and its bucket, only for a job that runs the real-server storage tests
# One part needs what another installs and runs once they are all done:
#   djvulibre the patched DjVu renderer (scripts/install-djvulibre.sh), built against the libjpeg and libtiff of the apt task and
#            checked against its ddjvu, or the cached build
# Every part runs under `timeout` with its own limit, so a part that hangs fails the step by name once its limit has
# passed, long before the job timeout. Each part logs to its own file; the logs are printed in groups afterwards, a
# failed or stopped part is printed in full outside a group, and a cancelled job prints them as well.
#
# Environment: ACTION_PATH, APT_DEBS, PIP_WHEELS (the directory of the cached wheels), APT_CACHE_HIT, VERAPDF_CACHE_HIT, LIBREDWG_CACHE_HIT, GHOSTXPS_CACHE_HIT, DJVULIBRE_CACHE_HIT and S3_TEST_SERVER (true or false). With
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
# covers its counted worst case (315 s: 165 pull, 30 start, 100 wait, 20 signature checks). The DjVu renderer builds
# only when its cache misses, after the other parts: the script took 41 s on four arm64 cores, and inside the apt task
# it made the cold task of the first CI run take 172 to 257 s and pass the limit of 300 s once, where the warm task takes
# 72 to 96 s; 240 s is more than twice what it can need on the four x64 cores of a runner. The job timeout is 15 minutes,
# so the step, at most 360 s and then 240 s, never leaves a job less than five.
declare -A task_limit_seconds=(
  [apt]=300
  [djvulibre]=240
  [pip]=180
  [verapdf]=240
  [epubcheck]=120
  [calibre]=240
  [libredwg]=300
  [ghostxps]=300
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
  export libredwg_cache_hit="${LIBREDWG_CACHE_HIT:-false}"
  export libredwg_dir=/opt/libredwg
  export ghostxps_cache_hit="${GHOSTXPS_CACHE_HIT:-false}"
  export ghostxps_dir=/opt/ghostxps
  export djvulibre_cache_hit="${DJVULIBRE_CACHE_HIT:-false}"
  export djvulibre_dir=/opt/djvulibre
  export pip_wheels="${PIP_WHEELS:?PIP_WHEELS}"
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
  tasks=(apt pip verapdf epubcheck calibre libredwg ghostxps raw)
  if [ "$s3_test_server" = true ]; then
    tasks+=(s3)
  fi
}

# Python format oracles (columnar readers, PDF text extraction, Word, Excel, EPUB, OLE2 and DXF readers, mesh measurement), pinned in
# pip-packages.txt, which is also the key of the wheel cache. The tests run python3 -I, which ignores user site-packages, so the
# pinned packages go to the system interpreter.
# --ignore-installed: the image ships an older distro PyMuPDF that pip cannot uninstall. Test-only; nothing ships.
task_pip() {
  local -a pins
  mapfile -t pins < <(grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$action_path/pip-packages.txt") || return 1
  # The wheels are fetched as the runner user, so the directory stays savable by the cache action; with a restored cache this
  # only reads the index metadata. The install then never touches the network.
  python3 -m pip download --only-binary=:all: --dest "$pip_wheels" "${pins[@]}" || return 1
  sudo python3 -m pip install --no-index --find-links "$pip_wheels" --break-system-packages --ignore-installed "${pins[@]}"
}

task_apt() {
  "$action_path/install-apt-tools.sh" "$apt_debs" "$action_path/apt-packages.txt" "$apt_cache_hit" || return 1
  # Pre-stage Tesseract traineddata assets for offline inference
  find /usr/share/tesseract-ocr /usr/share/tessdata -name "*.traineddata" -exec cp -u {} ./ \; 2>/dev/null || true
  # STEP and IGES input is read by our own program, linked to the Open CASCADE libraries of the runner image. It builds in seconds, so it
  # needs no cache, and it follows the packages, which is why it is part of this task and not a task of its own.
  sudo "$action_path/../../../native/cad-convert/build.sh" /usr/local/bin/cad-convert || return 1
  # Run without arguments the program prints its usage and exits 2; that line is the sign that it starts.
  local usage
  usage="$(cad-convert 2>&1 || true)"
  [[ "$usage" == *'usage: cad-convert'* ]] || { echo "cad-convert does not start" >&2; return 1; }
  # The qpdf job runner (native/qpdf-runner) opens the libqpdf of the packages above; it builds with the C compiler of the runner image.
  # --check loads the library and prints its version, which is the sign that the runner can serve the PDF operations.
  sudo "$action_path/../../../native/qpdf-runner/build.sh" /usr/local/bin/qpdf-runner || return 1
  qpdf-runner --check | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "qpdf-runner does not load libqpdf" >&2; return 1; }
}

# DjVu input is drawn by djvulibre built from the Debian source of 3.5.28 with two patches (scripts/install-djvulibre.sh), against the
# libjpeg and libtiff development packages of the apt task, so it follows the packages as cad-convert does. The distribution's ddjvu of
# the same version, which that task also installs for the oracle tools, is the reference the build is checked against. The build is
# cached by the runner image and the hash of the script and its patches; a restored build is used only when its programs still have
# the digests written at the build. The programs are linked into /usr/local/bin, which comes before /usr/bin for the worker and the oracles.
task_djvulibre() {
  local digest_file="$djvulibre_dir/programs.sha256"
  if [ "$djvulibre_cache_hit" = true ] && sha256sum --check --strict --status "$digest_file" 2> /dev/null; then
    sudo ln -sf "$djvulibre_dir/bin/ddjvu" /usr/local/bin/ddjvu
    sudo ln -sf "$djvulibre_dir/bin/djvused" /usr/local/bin/djvused
    return
  fi
  if [ "$djvulibre_cache_hit" = true ]; then echo "the cached djvulibre does not match its recorded digests; building it again"; fi
  sudo env DJVULIBRE_REFERENCE_DDJVU=/usr/bin/ddjvu "$action_path/../../../scripts/install-djvulibre.sh" "$djvulibre_dir" || return 1
  sha256sum "$djvulibre_dir/bin/ddjvu" "$djvulibre_dir/bin/djvused" | sudo tee "$digest_file" > /dev/null
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

# Ebook conversions are compared with calibre's `ebook-convert` (GPL-3.0, run as a separate process), which also writes the MOBI, AZW3, PDB, LRF and OEB books that tests/ebook-calibre-writers.test.ts reads back. The release archive carries
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

# DWG input is read by LibreDWG's `dwg2dxf` (GPL-3.0-or-later, an unmodified separate program), built from the pinned release
# archive in scripts/install-libredwg.sh, which checks the SHA-256 before anything in it runs. The build is cached by the hash of that script.
task_libredwg() {
  if [ "$libredwg_cache_hit" = true ] && [ -x "$libredwg_dir/bin/dwg2dxf" ]; then
    sudo ln -sf "$libredwg_dir/bin/dwg2dxf" /usr/local/bin/dwg2dxf
    dwg2dxf --version
  else
    sudo scripts/install-libredwg.sh "$libredwg_dir"
  fi
}

# XPS input is drawn by GhostXPS's `gxps` (GhostPDL, AGPL-3.0-or-later, an unmodified separate program), built from the pinned release
# archive in scripts/install-ghostxps.sh, which checks the SHA-256 before anything in it runs. The build is cached by the hash of that
# script, with the SHA-256 of the program beside it: a restored program is used only when it still has the digest written at the build,
# and is built again otherwise (a cache entry that does not match what was built is not run).
task_ghostxps() {
  local digest_file="$ghostxps_dir/gxps.sha256"
  if [ "$ghostxps_cache_hit" = true ] && [ -x "$ghostxps_dir/bin/gxps" ] && sha256sum --check --strict --status "$digest_file" 2> /dev/null; then
    sudo ln -sf "$ghostxps_dir/bin/gxps" /usr/local/bin/gxps
    gxps -v
    return
  fi
  if [ "$ghostxps_cache_hit" = true ]; then echo "the cached gxps does not match its recorded digest; building it again"; fi
  sudo scripts/install-ghostxps.sh "$ghostxps_dir"
  sha256sum "$ghostxps_dir/bin/gxps" | sudo tee "$digest_file" > /dev/null
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
export -f task_pip task_apt task_djvulibre task_verapdf task_epubcheck task_calibre task_libredwg task_ghostxps task_raw task_s3 s3_pull_image s3_obtain_image s3_wait_live s3_sign s3_check_signatures

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

# The two tools the STEP and IGES tests cannot run without, checked the way the tests look for them (the first of each on the PATH), once all
# parts are done: a missing one fails the step with its own name here, not as a collection error of every CAD suite later.
verify_cad_tools() {
  local usage python_problem
  if ! command -v cad-convert > /dev/null; then
    echo "::error::cad-convert is not on the PATH ($PATH); the apt task builds it into /usr/local/bin"
    return 1
  fi
  usage="$(cad-convert 2>&1 || true)"
  if [[ "$usage" != *'usage: cad-convert'* ]]; then
    echo "::error::$(command -v cad-convert) does not start: $usage"
    return 1
  fi
  if ! python_problem="$(python3 -I -c 'import trimesh' 2>&1)"; then
    echo "::error::$(command -v python3) -I cannot import trimesh: $python_problem"
    return 1
  fi
  echo "cad-convert: $(command -v cad-convert); python3 with trimesh: $(command -v python3)"
}

# DuckDB imports pytz when it hands a TIMESTAMPTZ value to Python without declaring it as a dependency, so pip-packages.txt pins it. This confirms
# the pinned module imports under python3 -I, because a missing one would fail only in the benchmark step.
verify_bench_python_modules() {
  local python_problem
  if ! python_problem="$(python3 -I -c 'import pytz' 2>&1)"; then
    echo "::error::$(command -v python3) -I cannot import pytz: $python_problem"
    return 1
  fi
  echo "python3 with pytz: $(command -v python3)"
}

# Runs the tasks that need what the others installed, under the same limits.
run_dependent_tasks() {
  tasks=(djvulibre)
  run_tasks
}

main() {
  configure
  select_tasks
  run_tasks || return 1
  run_dependent_tasks || return 1
  verify_cad_tools || return 1
  verify_bench_python_modules
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
