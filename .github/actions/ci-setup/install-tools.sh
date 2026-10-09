#!/usr/bin/env bash
# Sets up the test tools of one CI job. The parts do not depend on each other, so they run at once and the step
# lasts as long as the slowest one (the package install) instead of the sum of all of them:
#   apt      conversion and oracle CLIs, from the cached .deb files when the cache was restored
#   pip      the Python format oracles
#   verapdf  the PDF/A validator, from the cached install when the cache was restored
#   epubcheck the EPUB validator, from its release archive checked against a pinned SHA-256
#   raw      the RAW sample files
#   s3       the S3 test server and its bucket
# Each part logs to its own file; the logs are printed in groups afterwards and a failed part fails the step.
#
# Environment: ACTION_PATH, APT_DEBS, APT_CACHE_HIT, VERAPDF_CACHE_HIT, S3_TEST_SERVER_IMAGE and the
# STORAGE_TEST_S3_* variables of the job.
set -uo pipefail

action_path="${ACTION_PATH:?ACTION_PATH}"
apt_debs="${APT_DEBS:?APT_DEBS}"
apt_cache_hit="${APT_CACHE_HIT:-false}"
verapdf_cache_hit="${VERAPDF_CACHE_HIT:-false}"
verapdf_dir=/opt/verapdf

# Python format oracles (columnar readers, PDF text extraction, Word, EPUB and OLE2 readers): the tests run python3 -I, which ignores user
# site-packages, so the pinned packages go to the system interpreter.
# --ignore-installed: the image ships an older distro PyMuPDF that pip cannot uninstall. Test-only; nothing ships.
task_pip() {
  sudo python3 -m pip install --no-cache-dir --break-system-packages --ignore-installed pyarrow==25.0.1 duckdb==1.5.6 pymupdf==1.28.2 \
    python-docx==1.2.0 ebooklib==0.20 olefile==0.47
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

EPUBCHECK_VERSION=5.2.1
EPUBCHECK_SHA256=0532f6291faa2bb729dd253f958868a2a57dbd2c32f881a97c7c980c5940309e

# EPUB outputs are checked by the EPUB validator; the archive is checked before anything in it runs.
task_epubcheck() {
  local archive dir
  archive="$(mktemp --suffix=.zip)"
  dir=/opt/epubcheck
  curl -fsSL --retry 3 -o "$archive" "https://github.com/w3c/epubcheck/releases/download/v$EPUBCHECK_VERSION/epubcheck-$EPUBCHECK_VERSION.zip" || return 1
  echo "$EPUBCHECK_SHA256  $archive" | sha256sum -c - || return 1
  sudo rm -rf "$dir" && sudo mkdir -p "$dir" && sudo unzip -q "$archive" -d "$dir" || return 1
  printf '#!/bin/sh\nexec java -Djava.awt.headless=true -jar %s/epubcheck-%s/epubcheck.jar "$@"\n' "$dir" "$EPUBCHECK_VERSION" | sudo tee /usr/local/bin/epubcheck > /dev/null
  sudo chmod 755 /usr/local/bin/epubcheck
  epubcheck --version
}

task_raw() {
  npm run fixtures:raw
}

# Real-server leg of the S3 storage tests, which read STORAGE_TEST_S3_*: a server this repository did not write,
# which verifies SigV4 itself. It is started with `docker run` because a service container cannot pass
# `server /data`. The image is pinned by digest; move the pin if that image repository is removed. Anonymous
# registry pulls are rate limited, so the pull is retried before the step fails.
task_s3() {
  local pulled=0 attempt ready=0
  for attempt in 1 2 3; do
    if docker pull "$S3_TEST_SERVER_IMAGE"; then
      pulled=1
      break
    fi
    sleep $((attempt * 20))
  done
  if [ "$pulled" != 1 ]; then
    echo "could not pull $S3_TEST_SERVER_IMAGE after 3 attempts" >&2
    return 1
  fi
  docker run -d --name s3-test-server -p 127.0.0.1:9000:9000 \
    -e MINIO_ROOT_USER="$STORAGE_TEST_S3_ACCESS_KEY_ID" \
    -e MINIO_ROOT_PASSWORD="$STORAGE_TEST_S3_SECRET_ACCESS_KEY" \
    "$S3_TEST_SERVER_IMAGE"
  for attempt in $(seq 1 30); do
    if curl -fsS --max-time 5 "$STORAGE_TEST_S3_ENDPOINT/minio/health/live" > /dev/null; then
      ready=1
      break
    fi
    sleep 2
  done
  if [ "$ready" != 1 ]; then
    echo "S3 test server did not become live after 30 attempts" >&2
    docker logs s3-test-server >&2
    return 1
  fi

  # curl signs both requests with its own SigV4 implementation. The wrong secret must be refused, otherwise the
  # server would not enforce signatures and the client tests could not catch a signing bug.
  local empty_sha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
  s3_sign() {
    curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -X PUT \
      --user "$STORAGE_TEST_S3_ACCESS_KEY_ID:$1" --aws-sigv4 "aws:amz:us-east-1:s3" \
      -H "x-amz-content-sha256: $empty_sha256" "$STORAGE_TEST_S3_ENDPOINT/$2"
  }
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

logs="$(mktemp -d)"
tasks=(apt pip verapdf epubcheck raw s3)
declare -A pids

for task in "${tasks[@]}"; do
  "task_$task" > "$logs/$task.log" 2>&1 &
  pids[$task]=$!
done

failed=()
for task in "${tasks[@]}"; do
  if wait "${pids[$task]}"; then status=ok; else status=FAILED; failed+=("$task"); fi
  echo "::group::$task ($status)"
  cat "$logs/$task.log"
  echo "::endgroup::"
done

if [ "${#failed[@]}" -gt 0 ]; then
  echo "::error::tool setup failed: ${failed[*]}"
  exit 1
fi
