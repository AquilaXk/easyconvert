#!/usr/bin/env bash
# Builds the pinned libeot commit and installs its `eot2ttf` program, the decompressor of EOT fonts compressed with MicroType Express.
# libeot is MPL-2.0 (its LZCOMP files are Monotype's code under the MTX licence, whose terms its LICENSE file states). The program is
# built from the unmodified source at one commit, linked statically (so it needs nothing but the C library at run time) and used only as a
# separate program: it is never linked into the application. The commit is fetched by its full hash, which names its content, so a source
# that is not the pinned one cannot be built.
#
# The pin is a commit, not the 0.01 release that Debian packages (libeot0 and eot2ttf 0.01-5), because that release writes six composite
# glyphs of each of the two corpus fonts with their instruction bytes misplaced: fixed upstream on 2024-07-30 (667cf59, "add numInstr
# bytes for Composite glyph with WE_HAVE_INSTRUCTIONS flag"), with the other fixes of 2020 to 2026 (uninitialised values, undefined shifts,
# CFF-flavoured fonts, hdmx and vdmx tables). Bump LIBEOT_COMMIT when upstream moves, and run tests/font-eot-mtx.test.ts first.
#
# Usage: install-libeot.sh [install-dir]   (default /opt/libeot; needs a C compiler, git and tar)
# Installs <install-dir>/bin/eot2ttf and the licence text at <install-dir>/share/doc/libeot/copyright, and links the program into
# /usr/local/bin when it is run as root and the directory is not /usr/local. LIBEOT_REPOSITORY names another place to fetch from.
set -euo pipefail

LIBEOT_COMMIT="0407abddc581d32e9871ee41535183ee1d924d85"
LIBEOT_REPOSITORY="${LIBEOT_REPOSITORY:-https://github.com/umanwizard/libeot.git}"
INSTALL_DIR="${1:-/opt/libeot}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fetched="$work/fetched.git"
source_dir="$work/libeot"
git init --quiet --bare "$fetched"
git --git-dir="$fetched" fetch --quiet --depth 1 "$LIBEOT_REPOSITORY" "$LIBEOT_COMMIT"
[ "$(git --git-dir="$fetched" rev-parse FETCH_HEAD)" = "$LIBEOT_COMMIT" ] || { echo "libeot: fetched $(git --git-dir="$fetched" rev-parse FETCH_HEAD), not $LIBEOT_COMMIT" >&2; exit 1; }
mkdir "$source_dir"
git --git-dir="$fetched" archive "$LIBEOT_COMMIT" | tar -x -C "$source_dir"

# The sources of libeot_la_SOURCES and eot2ttf_SOURCES in Makefile.am, compiled with its release flags (-O2 --std=c99 -DDECOMPRESS_ON).
# The assertions of the decoder stay on: a stream that breaks one stops the program (SIGABRT) instead of being read past its end.
cd "$source_dir"
sources=(
  src/eot2ttf.c src/libeot.c src/EOT.c src/writeFontFile.c src/triplet_encodings.c
  src/ctf/parseCTF.c src/ctf/parseTTF.c src/ctf/SFNTContainer.c src/util/stream.c
  src/lzcomp/ahuff.c src/lzcomp/bitio.c src/lzcomp/liblzcomp.c src/lzcomp/lzcomp.c src/lzcomp/mtxmem.c
)
cc --std=c99 -D_DEFAULT_SOURCE -DDECOMPRESS_ON -O2 -D_FORTIFY_SOURCE=2 -fstack-protector-strong -static -Iinc -Isrc \
  -o "$work/eot2ttf" "${sources[@]}" 2> "$work/cc.log" || { tail -n 40 "$work/cc.log" >&2; exit 1; }

install -d "$INSTALL_DIR/bin" "$INSTALL_DIR/share/doc/libeot"
install -m 0755 "$work/eot2ttf" "$INSTALL_DIR/bin/eot2ttf"
# The Debian-style name, so the image collects it into /licenses with the system notices; the patent note travels with it.
cat LICENSE PATENTS > "$work/copyright"
install -m 0644 "$work/copyright" "$INSTALL_DIR/share/doc/libeot/copyright"
printf 'libeot, unmodified, built from commit %s of %s\n' "$LIBEOT_COMMIT" "$LIBEOT_REPOSITORY" > "$INSTALL_DIR/share/doc/libeot/SOURCE"

if [ "$(id -u)" -eq 0 ] && [ "$INSTALL_DIR" != "/usr/local" ]; then
  ln -sf "$INSTALL_DIR/bin/eot2ttf" /usr/local/bin/eot2ttf
fi
# Run without arguments the program prints its usage and exits 1: that it starts at all is the check.
started="$("$INSTALL_DIR/bin/eot2ttf" 2>&1 || true)"
case "$started" in "Usage: "*) ;; *) echo "libeot: eot2ttf did not start: $started" >&2; exit 1 ;; esac
