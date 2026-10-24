#!/usr/bin/env bash
# Builds the pinned GhostPDL release and installs its `gxps` program (GhostXPS), the renderer of XPS and OpenXPS
# documents. GhostPDL is AGPL-3.0-or-later. The program is built from the unmodified release archive with the copies of
# its libraries that ship in that archive (FreeType, zlib, libpng, libjpeg, lcms2mt, libtiff, JPEG XR, Expat), so it
# needs nothing but the C library at run time, and its fonts and colour profiles are compiled into it. It is used only as
# a separate program: it is never linked into the application. The archive is verified against a fixed SHA-256 before
# anything in it runs. Debian ships no package of GhostXPS (its ghostscript package is built from the Ghostscript
# archive, which leaves the XPS interpreter out).
#
# Bump GHOSTPDL_VERSION, GHOSTPDL_TAG and GHOSTPDL_SHA256 together (the digest of `ghostpdl-<version>.tar.xz` on the
# release page; the release's SHA512SUMS lists the same file) and run tests/xps-render.test.ts before moving the pin.
#
# Usage: install-ghostxps.sh [install-dir]   (default /opt/ghostxps; needs a C compiler, make, curl and xz)
# Installs <install-dir>/bin/gxps and the licence text at <install-dir>/share/doc/ghostxps/copyright, and links the
# program into /usr/local/bin when it is run as root and the directory is not /usr/local.
set -euo pipefail

GHOSTPDL_VERSION="10.08.0"
GHOSTPDL_TAG="gs10080"
GHOSTPDL_SHA256="94943e3c4adb7115d132b3c28b913672f2e62e6a9d802f7e754e716b1634174a"
GHOSTPDL_URL="https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/${GHOSTPDL_TAG}/ghostpdl-${GHOSTPDL_VERSION}.tar.xz"
INSTALL_DIR="${1:-/opt/ghostxps}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --retry 3 -o "$work/ghostpdl.tar.xz" "$GHOSTPDL_URL"
echo "${GHOSTPDL_SHA256}  $work/ghostpdl.tar.xz" | sha256sum --check --strict -
tar -xJf "$work/ghostpdl.tar.xz" -C "$work"
source_dir="$work/ghostpdl-${GHOSTPDL_VERSION}"

# The XPS interpreter is built on the PCL front end (configure enables it only with PCL), so PCL stays configured; only
# the gxps program is made. The PostScript output devices (pdfwrite among them) are the only drivers: the worker asks
# for PDF and draws the pages from it. Nothing that reaches outside the process is built: no X11, CUPS, GTK,
# fontconfig, D-Bus, IJS or OCR.
#
# The program parses attacker-controlled bytes with decoders that ship in the archive (JPEG XR, libtiff, libpng, FreeType,
# lcms2mt, Expat), so it is built as a position-independent executable (its load address differs on every run)
# with the stack protector and stack clash probes, and linked with a read-only relocation table and immediate binding
# (Debian hardening-wrapper flags: relro, bindnow, pie).
hardening_cflags="-O2 -D_FORTIFY_SOURCE=2 -fstack-protector-strong -fstack-clash-protection -fPIE"
hardening_ldflags="-Wl,-z,relro,-z,now -pie"
cd "$source_dir"
./configure \
  --without-x \
  --disable-cups \
  --disable-gtk \
  --disable-fontconfig \
  --disable-dbus \
  --without-libidn \
  --without-libpaper \
  --without-tesseract \
  --without-ijs \
  --without-pdf \
  --without-gpdl \
  --with-drivers=PS \
  CFLAGS="$hardening_cflags" \
  LDFLAGS="$hardening_ldflags" \
  > "$work/configure.log" 2>&1 || { tail -n 40 "$work/configure.log" >&2; exit 1; }
jobs="$(nproc 2> /dev/null || echo 2)"
make -j"$jobs" gxps > "$work/make.log" 2>&1 || { tail -n 40 "$work/make.log" >&2; exit 1; }

# A build that lost a hardening property is a failed build: the program must be position independent (ELF type DYN), have a
# read-only relocation table (GNU_RELRO) and bind every symbol at load time (BIND_NOW).
elf_header="$(readelf -h bin/gxps)"
elf_dynamic="$(readelf -lW -d bin/gxps)"
grep -q 'Type:[[:space:]]*DYN' <<< "$elf_header" || { echo "gxps is not a position independent executable" >&2; exit 1; }
grep -q 'GNU_RELRO' <<< "$elf_dynamic" || { echo "gxps has no read-only relocation segment" >&2; exit 1; }
grep -Eq 'BIND_NOW|FLAGS_1.*NOW' <<< "$elf_dynamic" || { echo "gxps does not bind its symbols at load time" >&2; exit 1; }

install -d "$INSTALL_DIR/bin" "$INSTALL_DIR/share/doc/ghostxps"
install -m 0755 bin/gxps "$INSTALL_DIR/bin/gxps"
# The Debian-style name, so the image collects it into /licenses with the system notices.
install -m 0644 LICENSE "$INSTALL_DIR/share/doc/ghostxps/copyright"
printf 'GhostXPS (GhostPDL %s), unmodified, built from %s\nSHA-256 %s\n' "$GHOSTPDL_VERSION" "$GHOSTPDL_URL" "$GHOSTPDL_SHA256" > "$INSTALL_DIR/share/doc/ghostxps/SOURCE"

if [ "$(id -u)" -eq 0 ] && [ "$INSTALL_DIR" != "/usr/local" ]; then
  ln -sf "$INSTALL_DIR/bin/gxps" /usr/local/bin/gxps
fi
"$INSTALL_DIR/bin/gxps" -v
