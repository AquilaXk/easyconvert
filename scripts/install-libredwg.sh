#!/usr/bin/env bash
# Builds the pinned LibreDWG release and installs its `dwg2dxf` program, the DWG reader of the DWG to DXF step.
# LibreDWG is GPL-3.0-or-later. The program is built from the unmodified release archive, linked statically (so it
# needs nothing but the C library at run time) and used only as a separate program: it is never linked into the
# application. The archive is verified against a fixed SHA-256 before anything in it runs.
#
# The pin is a snapshot of the 0.14 series, not the 0.14 release itself: the release of 2026-06-27 still has the heap
# overflow in the R2004 section decompressor that was fixed on 2026-07-01 (GHSA-qg2f-8389-w95j, first in 0.14.8396).
# Bump LIBREDWG_VERSION and LIBREDWG_SHA256 together (the digest is the `tar.xz` line of the release's dist.sha256) and
# run tests/cad-dwg-reader.test.ts and the fuzz suite before moving the pin.
#
# Usage: install-libredwg.sh [install-dir]   (default /opt/libredwg; needs a C compiler, make, curl and xz)
# Installs <install-dir>/bin/dwg2dxf and the licence text at <install-dir>/share/doc/libredwg/copyright, and links
# the program into /usr/local/bin when it is run as root and the directory is not /usr/local.
set -euo pipefail

LIBREDWG_VERSION="0.14.8601"
LIBREDWG_SHA256="f1140a219d6edb291e55fad740be6c5e49c046fee558860575aeef110caa4ef9"
LIBREDWG_URL="https://github.com/LibreDWG/libredwg/releases/download/${LIBREDWG_VERSION}/libredwg-${LIBREDWG_VERSION}.tar.xz"
INSTALL_DIR="${1:-/opt/libredwg}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --retry 3 -o "$work/libredwg.tar.xz" "$LIBREDWG_URL"
echo "${LIBREDWG_SHA256}  $work/libredwg.tar.xz" | sha256sum --check --strict -
tar -xJf "$work/libredwg.tar.xz" -C "$work"
source_dir="$work/libredwg-${LIBREDWG_VERSION}"

# --enable-release: the settings of an official release (no unstable objects, no unknown versions).
# --disable-write: the program only reads DWG; the writer is not built.
# Bindings, documentation and shared libraries are not needed for one command-line program.
cd "$source_dir"
./configure \
  --prefix="$INSTALL_DIR" \
  --enable-release \
  --disable-write \
  --disable-bindings \
  --disable-docs \
  --disable-python \
  --disable-shared \
  --enable-static \
  --without-libiconv-prefix \
  CFLAGS="-O2 -D_FORTIFY_SOURCE=2 -fstack-protector-strong" \
  > "$work/configure.log" 2>&1 || { tail -n 40 "$work/configure.log" >&2; exit 1; }
jobs="$(nproc 2> /dev/null || echo 2)"
{ make -j"$jobs" -C src && make -C programs dwg2dxf; } > "$work/make.log" 2>&1 || { tail -n 40 "$work/make.log" >&2; exit 1; }

install -d "$INSTALL_DIR/bin" "$INSTALL_DIR/share/doc/libredwg"
install -m 0755 programs/dwg2dxf "$INSTALL_DIR/bin/dwg2dxf"
# The Debian-style name, so the image collects it into /licenses with the system notices.
install -m 0644 COPYING "$INSTALL_DIR/share/doc/libredwg/copyright"
printf 'GNU LibreDWG %s, unmodified, built from %s\nSHA-256 %s\n' "$LIBREDWG_VERSION" "$LIBREDWG_URL" "$LIBREDWG_SHA256" > "$INSTALL_DIR/share/doc/libredwg/SOURCE"

if [ "$(id -u)" -eq 0 ] && [ "$INSTALL_DIR" != "/usr/local" ]; then
  ln -sf "$INSTALL_DIR/bin/dwg2dxf" /usr/local/bin/dwg2dxf
fi
"$INSTALL_DIR/bin/dwg2dxf" --version
