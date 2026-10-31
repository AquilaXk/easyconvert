#!/usr/bin/env bash
# Builds sharp's libvips-cpp.so with the upstream build (build/posix.sh of sharp-libvips at UPSTREAM_SHA, unpacked by
# toolchain.sh into /packaging), changed by five patches:
#   option-f.patch        mozjpeg, libpng and libwebp at -O3 (posix.sh lines 204, 212 and 225) instead of the -Os default of
#                         lines 44-46; the other libraries keep the upstream flags;
#   aom-release.patch     aom as a Release build (libaom's own default build type) at -O3 instead of MinSizeRel at -Os
#                         (posix.sh lines 181-182), on both platforms;
#   pinned-notices.patch  the notices file from the pinned archive instead of the upstream main branch;
#   webp-thread-level.patch  one line in posix.sh that applies libvips-webp-thread-level.patch to the libvips sources, which sets
#                         libwebp's thread_level for a picture with an alpha band (its alpha plane is compressed on a second thread) in webpsave.c;
#   heif-auto-tiles.patch  one line in posix.sh, after the line above, that applies libvips-heif-auto-tiles.patch, which leaves the AV1
#                         encoder's auto-tiles off in heifsave.c (libheif's default), so an AVIF is one tile whatever the thread count.
# Every source the script downloads with curl goes through fetch-pinned.sh, Meson may use only the subprojects its tarballs
# unpack (--wrap-mode=nodownload in env.sh), and git-local-only.sh answers only the local queries of git. The library is written to
# <out>/libvips-cpp.so.<VIPS_VERSION> with the digest file beside it, the two files use-libvips.sh and the worker image take
# (check-build-output.sh).
#
# It runs once, in a fresh layer over the toolchain stage (posix.sh creates /deps and /target and fails if they exist).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/env.sh"
out="$1"

cd /packaging
patch -p1 --forward < "$here/option-f.patch"
patch -p1 --forward --fuzz=0 < "$here/aom-release.patch"
patch -p1 --forward < "$here/pinned-notices.patch"
patch -p1 --forward < "$here/webp-thread-level.patch"
patch -p1 --forward < "$here/heif-auto-tiles.patch"
export SHARP_LIBVIPS_WEBP_THREAD_PATCH="$here/libvips-webp-thread-level.patch"
export SHARP_LIBVIPS_HEIF_TILES_PATCH="$here/libvips-heif-auto-tiles.patch"
# The COPY lines of the upstream Dockerfile.
cp "platforms/$PLATFORM/Toolchain.cmake" "platforms/$PLATFORM/meson.ini" /root/
install -m 0755 "platforms/$PLATFORM/$PKGCONF_WRAPPER" /usr/bin/

fetches="$(mktemp -d)"
install -m 0755 "$here/fetch-pinned.sh" "$fetches/curl"
install -m 0755 "$here/git-local-only.sh" "$fetches/git"
export SHARP_LIBVIPS_SOURCES="$here/sources.sha256"
export SHARP_LIBVIPS_REFUSALS="$fetches/refused"
export SHARP_LIBVIPS_SERVED="$fetches/served"
touch "$SHARP_LIBVIPS_REFUSALS" "$SHARP_LIBVIPS_SERVED"

export_compiler_settings
# A wrapper bash could not run would be passed over for the program after it on PATH, which checks nothing.
for wrapped in curl git; do
  [ "$(PATH="$fetches:$PATH" command -v "$wrapped")" = "$fetches/$wrapped" ]
done
status=0
PATH="$fetches:$PATH" bash build/posix.sh || status=$?
if [ -s "$SHARP_LIBVIPS_REFUSALS" ]; then
  echo "build/posix.sh asked for downloads that are not pinned, or for more of git than a local query:" >&2
  cat "$SHARP_LIBVIPS_REFUSALS" >&2
  exit 1
fi
[ "$status" -eq 0 ] || exit "$status"
# A pin the script no longer asks for means sources.sha256 belongs to another release.
diff <(sort -u "$SHARP_LIBVIPS_SERVED") <(awk '$1 !~ /^#/ { print $2 }' "$SHARP_LIBVIPS_SOURCES" | sort -u)

name="libvips-cpp.so.${VIPS_VERSION}"
install -D -m 0644 "/target/lib/$name" "$out/$name"
(cd "$out" && sha256sum "$name" | tee "$name.sha256")
readelf -p .comment "$out/$name"
