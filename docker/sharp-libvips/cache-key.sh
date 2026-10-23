#!/usr/bin/env bash
# usage: cache-key.sh <checkout root>
# Prints the cache key of the CI build of the sharplibvips stage (.github/workflows/sharp-libvips.yml): a digest of what the
# stage is built from, which is its lines in Dockerfile.worker and the files its COPY lines copy from the checkout. CI builds
# linux/amd64 only.
set -euo pipefail
cd "$1"

stage="$(sed -n '/^FROM .* AS sharplibvips-build$/,/^COPY --from=sharplibvips-build /p' Dockerfile.worker)"
if [ -z "$stage" ]; then
  echo "no sharplibvips-build stage in $1/Dockerfile.worker" >&2
  exit 1
fi
# The sources of each COPY from the checkout: every word but the instruction and the destination (paths without spaces).
sources="$(awk '$1 == "COPY" && $2 !~ /^--from=/ { for (i = 2; i < NF; i++) print $i }' <<< "$stage")"
if [ -z "$sources" ]; then
  echo "the sharplibvips-build stage of $1/Dockerfile.worker copies nothing from the checkout" >&2
  exit 1
fi
digest="$({
  printf '%s\n' "$stage"
  find $sources -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum
} | sha256sum | cut -d ' ' -f 1)"
echo "sharp-libvips-linux-x64-${digest}"
