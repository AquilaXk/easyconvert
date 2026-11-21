#!/usr/bin/env bash
# Runs the quality benchmark inside the worker image, so the office suite it meets is the one production runs (LibreOffice 26.8 from
# trixie-backports, docs/policy-decisions.md entries 383 and 385) and not the runner's own. Both sides of a row see that suite: our side
# starts it through the worker's sandbox, the reference side starts `soffice --convert-to` as the benchmark always did.
#
#   scripts/bench-in-worker-image.sh <image> [bench arguments]
#
# The checkout is mounted read-write (the report goes to bench-results/, the reference measurements to .bench-cache/), the node_modules of the
# checkout are the host's (`npm ci --ignore-scripts` on a host of the image's architecture), and the node of the image runs the benchmark. The
# container has the flags of the worker service of docker-compose.yml (no capabilities, no new privileges, the seccomp profile of the repository),
# so the sandbox of the worker runs in it as it runs in production. Two things are added that the image does not ship because the worker does not
# need them: the Python format oracles of the families that read their outputs back (the wheels of .github/actions/ci-setup/pip-packages.txt for the
# image's Python, unpacked into a directory that is mounted over its dist-packages) and, when the host has installed it (task_epubcheck of
# .github/actions/ci-setup/install-tools.sh), EPUBCheck, which the image's Java runs.
#
# Families whose reference side needs a tool the image does not carry cannot run here: `vector` writes AVIF and ICO with the ImageMagick of the
# host, and the image's ImageMagick has neither (its policy allows only the decoders the worker calls, and its libheif has no encoder).
#
# Environment:
#   CONTAINER_ENGINE         docker (default) or podman
#   BENCH_IMAGE_RUN_FLAGS    more flags for `run` (on a rootless podman host: --userns=keep-id)
#   BENCH_IMAGE_ORACLES      the directory the Python oracles are unpacked into (default: a new one under TMPDIR)
#   BENCH_IMAGE_PYTHON       the image's Python as <major>.<minor> (default: asked of the image)
#   BENCH_IMAGE_DRY_RUN=1    print the command instead of running it (the tests read it)
# ORACLE_STRICT_MODE, MALLOC_ARENA_MAX, BENCH_CORPUS_TIER and the GITHUB_* variables the report records its run from are passed on.
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <image> [bench arguments]" >&2
  exit 2
fi
image="$1"
shift

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
engine="${CONTAINER_ENGINE:-docker}"
dry="${BENCH_IMAGE_DRY_RUN:-0}"
# The oracles the families that run here read their outputs back with (the version pins are those of the runner's own install).
oracle_pattern='^(pyarrow|duckdb|pytz|pymupdf|openpyxl|olefile|xlrd|ezdxf)=='

case "$(uname -m)" in
  x86_64) platform=manylinux_2_28_x86_64 ;;
  aarch64 | arm64) platform=manylinux_2_28_aarch64 ;;
  *) echo "no wheel platform is known for $(uname -m)" >&2; exit 2 ;;
esac

python_version="${BENCH_IMAGE_PYTHON:-}"
if [ -z "$python_version" ]; then
  python_version="$("$engine" run --rm --entrypoint python3 "$image" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
fi

oracles="${BENCH_IMAGE_ORACLES:-$(mktemp -d)}"
if [ "$dry" != 1 ]; then
  mkdir -p "$oracles"
  requirements="$(mktemp)"
  grep -E "$oracle_pattern" "$root/.github/actions/ci-setup/pip-packages.txt" > "$requirements"
  python3 -m pip install --quiet --disable-pip-version-check --target "$oracles" --only-binary=:all: \
    --implementation cp --python-version "$python_version" --platform "$platform" --platform manylinux2014_"$(uname -m)" \
    -r "$requirements"
  rm -f "$requirements"
fi

args=(
  run --rm
  --user "$(id -u):$(id -g)"
  --cap-drop ALL
  --security-opt no-new-privileges:true
  --security-opt "seccomp=$root/docker/seccomp-worker.json"
  --tmpfs /tmp:rw,nosuid,nodev,size=4g,mode=1777
  --tmpfs /home/easyconvert:rw,nosuid,nodev,size=512m,mode=0777
  -e HOME=/home/easyconvert
  -v "$root:/work"
  -w /work
  -v "$oracles:/usr/local/lib/python$python_version/dist-packages:ro"
)
for name in ORACLE_STRICT_MODE MALLOC_ARENA_MAX BENCH_CORPUS_TIER GITHUB_SHA GITHUB_REF_NAME GITHUB_HEAD_REF GITHUB_EVENT_NAME; do
  if [ -n "${!name:-}" ]; then args+=(-e "$name=${!name}"); fi
done
if [ -d /opt/epubcheck ] && [ -x /usr/local/bin/epubcheck ]; then
  args+=(-v /opt/epubcheck:/opt/epubcheck:ro -v /usr/local/bin/epubcheck:/usr/local/bin/epubcheck:ro)
fi
if [ -n "${BENCH_IMAGE_RUN_FLAGS:-}" ]; then
  # shellcheck disable=SC2206 # the flags are words by design
  args+=(${BENCH_IMAGE_RUN_FLAGS})
fi
# The image sets NODE_ENV=production, which the storage layer takes as a deployment that must name its driver; a test run names none.
args+=(--entrypoint bash "$image" -c 'unset NODE_ENV; exec node node_modules/.bin/tsx bench/run.ts "$@"' bench "$@")

if [ "$dry" = 1 ]; then
  printf '%s' "$engine"
  printf ' %q' "${args[@]}"
  printf '\n'
  exit 0
fi
exec "$engine" "${args[@]}"
