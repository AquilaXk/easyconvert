#!/usr/bin/env bash
# Builds the pinned LibRaw development snapshot and installs its `dcraw_emu` program, the decoder of Nikon NEF files with High
# Efficiency (HE) and High Efficiency* (HE*) compression, which no released LibRaw reads (0.22.3 and earlier). The decoder,
# `src/decoders/nikonhe.cpp`, came with "LibRaw snapshot 202611" (2026-11-04). LibRaw is licensed under the LGPL-2.1 or the CDDL-1.0 at the
# user's choice. The program is built from the unmodified source of one commit, linked statically against the library built in the
# same tree (so it needs only the C, C++ and OpenMP libraries of the image) and used only as a separate program, for the NEF
# files named above and for no other file: it is never linked into the application, and every other camera file keeps the
# distribution's LibRaw. The source is fetched by commit hash and the commit is checked before anything in it is built.
#
# The pin is the commit of 2026-11-08 at the head of `master` when it was chosen: the snapshot commit (4d9bd21acdf3, 2026-11-04) plus the
# changes up to then. Bump LIBRAW_HE_COMMIT when a release carrying the decoder (0.23) is the distribution's, and then drop this script;
# run tests/raw-nikon-he-decode.test.ts and the `raw` family of the quality bench before moving the pin.
#
# Usage: install-libraw-he.sh [install-dir]   (default /opt/libraw-he; needs a C++ compiler, make and git)
# Installs <install-dir>/bin/dcraw_emu, and the licence texts at <install-dir>/share/doc/libraw-he/copyright and the note that names
# the source at <install-dir>/share/doc/libraw-he/SOURCE; links the program as /usr/local/bin/dcraw_emu_he when it is run as root
# and the directory is not /usr/local.
set -euo pipefail

LIBRAW_HE_COMMIT="a9a14b1970d188c25dade81f8326ff00a6e33649"
LIBRAW_HE_URL="https://github.com/LibRaw/LibRaw.git"
INSTALL_DIR="${1:-/opt/libraw-he}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

source_dir="$work/LibRaw"
git init --quiet "$source_dir"
git -C "$source_dir" fetch --quiet --depth 1 "$LIBRAW_HE_URL" "$LIBRAW_HE_COMMIT"
fetched="$(git -C "$source_dir" rev-parse FETCH_HEAD)"
if [ "$fetched" != "$LIBRAW_HE_COMMIT" ]; then
  echo "LibRaw: fetched commit $fetched, expected $LIBRAW_HE_COMMIT" >&2
  exit 1
fi
# The working tree is the exported commit, not a checkout of a branch.
git -C "$source_dir" archive --format=tar "$LIBRAW_HE_COMMIT" | tar -x -C "$work/" --one-top-level=LibRaw-src
cd "$work/LibRaw-src"
test -f src/decoders/nikonhe.cpp

# Makefile.dist is the project's own build file for the library and the sample programs. OpenMP is what the distribution's LibRaw
# uses. The optional zlib (floating-point DNG), JPEG (lossy DNG) and LCMS (embedded profiles) support is left out: this program is run
# on Nikon NEF files only, and the output profile is the built-in sRGB.
jobs="$(nproc 2> /dev/null || echo 2)"
make -f Makefile.dist -j"$jobs" \
  CFLAGS="-O3 -I. -w -fopenmp -D_FORTIFY_SOURCE=2 -fstack-protector-strong" \
  LDADD="" \
  lib/libraw.a bin/dcraw_emu > "$work/make.log" 2>&1 || { tail -n 40 "$work/make.log" >&2; exit 1; }

install -d "$INSTALL_DIR/bin" "$INSTALL_DIR/share/doc/libraw-he"
install -m 0755 bin/dcraw_emu "$INSTALL_DIR/bin/dcraw_emu"
# The Debian-style name, so the image collects it into /licenses with the system notices.
cat COPYRIGHT LICENSE.CDDL LICENSE.LGPL > "$INSTALL_DIR/share/doc/libraw-he/copyright"
chmod 0644 "$INSTALL_DIR/share/doc/libraw-he/copyright"
chmod 0644 "$INSTALL_DIR/share/doc/libraw-he/SOURCE" 2> /dev/null || true
printf 'LibRaw development snapshot 202611, unmodified, commit %s of %s\nLGPL-2.1 or CDDL-1.0; built with Makefile.dist as a separate program, used only for Nikon NEF files with High Efficiency compression\n' "$LIBRAW_HE_COMMIT" "$LIBRAW_HE_URL" > "$INSTALL_DIR/share/doc/libraw-he/SOURCE"

if [ "$(id -u)" -eq 0 ] && [ "$INSTALL_DIR" != "/usr/local" ]; then
  ln -sf "$INSTALL_DIR/bin/dcraw_emu" /usr/local/bin/dcraw_emu_he
fi
# `dcraw_emu` with no file prints its usage and exits 1, so the check reads the text.
usage="$("$INSTALL_DIR/bin/dcraw_emu" 2>&1 || true)"
case "$usage" in
  *"almost complete dcraw emulator"*) echo "dcraw_emu of LibRaw commit $LIBRAW_HE_COMMIT installed in $INSTALL_DIR" ;;
  *) echo "dcraw_emu did not start" >&2; exit 1 ;;
esac
