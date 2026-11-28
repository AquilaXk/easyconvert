#!/usr/bin/env bash
# Builds the pinned LibreDWG release and installs its `dwg2dxf` program (the DWG reader of the DWG to DXF step) and its
# `dxf2dwg` program (the DWG writer of the DXF to DWG and DWG to DWG steps).
# LibreDWG is GPL-3.0-or-later. The programs are built from the unmodified release archive, linked statically (so they
# need nothing but the C library at run time) and used only as separate programs: they are never linked into the
# application. The archive is verified against a fixed SHA-256 before anything in it runs.
#
# The pin is the 0.15 release of 2026-11-28. The snapshot this script pinned before (0.14.8601) is no longer published,
# and the heap overflow in the R2004 section decompressor (GHSA-qg2f-8389-w95j) is fixed completely only in 0.15: its
# notes list the bypass of the first fix. Its release notes also say that the writer encodes every DWG version. Bump LIBREDWG_VERSION and LIBREDWG_SHA256 together (the digest is the `tar.xz` line of the
# release notes) and run tests/cad-dwg-reader.test.ts, tests/cad-dwg-writer.test.ts and the fuzz suite before moving the pin.
#
# Usage: install-libredwg.sh [install-dir]   (default /opt/libredwg; needs a C compiler, make, curl and xz)
# Installs <install-dir>/bin/dwg2dxf and <install-dir>/bin/dxf2dwg and the licence text at
# <install-dir>/share/doc/libredwg/copyright, and links the programs into /usr/local/bin when it is run as root and the
# directory is not /usr/local.
set -euo pipefail

LIBREDWG_VERSION="0.15"
LIBREDWG_SHA256="fa24ad4798fcb68ac3432bc6658f037a58d094bde764fa2ca32d86a25266b48d"
LIBREDWG_URL="https://github.com/LibreDWG/libredwg/releases/download/${LIBREDWG_VERSION}/libredwg-${LIBREDWG_VERSION}.tar.xz"
INSTALL_DIR="${1:-/opt/libredwg}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --retry 3 -o "$work/libredwg.tar.xz" "$LIBREDWG_URL"
echo "${LIBREDWG_SHA256}  $work/libredwg.tar.xz" | sha256sum --check --strict -
tar -xJf "$work/libredwg.tar.xz" -C "$work"
source_dir="$work/libredwg-${LIBREDWG_VERSION}"

# The archive has no .git directory, so configure builds it with the settings of an official release (no unstable objects,
# no unknown versions) without --enable-release, which since 0.15 also demands GNU plotutils for the `dwgplot` program.
# The writer stays enabled (the default): `dxf2dwg` needs it.
# Bindings, documentation and shared libraries are not needed for two command-line programs.
cd "$source_dir"
./configure \
  --prefix="$INSTALL_DIR" \
  --disable-bindings \
  --disable-docs \
  --disable-python \
  --disable-shared \
  --enable-static \
  --without-libiconv-prefix \
  CFLAGS="-O2 -D_FORTIFY_SOURCE=2 -fstack-protector-strong" \
  > "$work/configure.log" 2>&1 || { tail -n 40 "$work/configure.log" >&2; exit 1; }
jobs="$(nproc 2> /dev/null || echo 2)"
{ make -j"$jobs" -C src && make -C programs dwg2dxf dxf2dwg; } > "$work/make.log" 2>&1 || { tail -n 40 "$work/make.log" >&2; exit 1; }

install -d "$INSTALL_DIR/bin" "$INSTALL_DIR/share/doc/libredwg"
install -m 0755 programs/dwg2dxf "$INSTALL_DIR/bin/dwg2dxf"
install -m 0755 programs/dxf2dwg "$INSTALL_DIR/bin/dxf2dwg"
# The Debian-style name, so the image collects it into /licenses with the system notices.
install -m 0644 COPYING "$INSTALL_DIR/share/doc/libredwg/copyright"
printf 'GNU LibreDWG %s, unmodified, built from %s\nSHA-256 %s\n' "$LIBREDWG_VERSION" "$LIBREDWG_URL" "$LIBREDWG_SHA256" > "$INSTALL_DIR/share/doc/libredwg/SOURCE"

if [ "$(id -u)" -eq 0 ] && [ "$INSTALL_DIR" != "/usr/local" ]; then
  ln -sf "$INSTALL_DIR/bin/dwg2dxf" /usr/local/bin/dwg2dxf
  ln -sf "$INSTALL_DIR/bin/dxf2dwg" /usr/local/bin/dxf2dwg
fi
"$INSTALL_DIR/bin/dwg2dxf" --version
"$INSTALL_DIR/bin/dxf2dwg" --version
