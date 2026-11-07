#!/usr/bin/env bash
# Builds the WOFF2 command-line programs of the pinned google/woff2 source (`woff2_compress` and `woff2_decompress`, MIT) and installs
# them as separate programs. They are the reference implementation of the format: the worker runs them sandboxed on the font it has
# parsed, and the in-process codec of src/lib/conversions/font-woff2.ts is the fallback for a worker without them
# (docs/policy-decisions.md, entry 173).
#
# Everything that decides what the programs do is pinned: the woff2 commit and the commit of the Brotli library it takes as a submodule
# (the woff2 tree at that commit points at the Brotli commit below), each as the archive GitHub serves for the commit, checked against a
# SHA-256 before anything in it is unpacked or run. The programs are built with the Makefile of the woff2 tree, which lists the sources
# of both libraries and the flags upstream builds with; what this script adds is the optimisation flags (see BUILD_FLAGS) and nothing
# else. The digest of the program is printed and written to the SOURCE note but not pinned: another compiler release writes other
# machine code for it.
#
# Bump the four values together (the woff2 tree at the new commit names the Brotli commit it needs; GitHub archives are verified by
# computing the digest of the download) and run the font tests with the new programs before moving the pin.
#
# Usage: install-woff2.sh [install-dir]   (default /opt/woff2; Linux; needs g++, gcc, make, curl, tar and sha256sum)
# Installs <install-dir>/bin/woff2_compress and woff2_decompress with the licence texts at <install-dir>/share/doc/woff2/copyright and a
# SOURCE note, and links the programs into /usr/local/bin when it is run as root and the directory is not /usr/local.
set -euo pipefail

WOFF2_COMMIT="7b67e12355fe7da148db5c19d4261f0a498a9537"
WOFF2_SHA256="af25f87356507cd541fe02eb52145ce21d0a62b2ef028c058720ecf96ad4d7f8"
BROTLI_VERSION="1.2.1"
BROTLI_COMMIT="db24a98aed38a16de78cc05ca15cdd8dc2a0d92d"
BROTLI_SHA256="113b9685dfc14dd2f3360d077283266eec2fbdfb0fe3e5600f11be151da0d68e"
# Added to the flags of the woff2 Makefile (empty: the Makefile's own flags).
BUILD_FLAGS="-O3"
# The archives are under a megabyte. curl refuses a download whose announced size is larger, and fetch stops reading at the bound plus
# one byte whatever the server announces, so that nothing larger than the bound is written before its digest is checked.
MAX_DOWNLOAD_BYTES=$((16 * 1024 * 1024))
INSTALL_DIR="${1:-/opt/woff2}"

if [ "$(uname -s)" != "Linux" ]; then
  echo "install-woff2.sh: the programs are built for Linux, not $(uname -s)" >&2
  exit 1
fi
for tool in g++ gcc make curl tar sha256sum; do
  command -v "$tool" > /dev/null || { echo "install-woff2.sh: $tool is needed to build the programs" >&2; exit 1; }
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fetch() {
  local status=0
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --max-filesize "$MAX_DOWNLOAD_BYTES" --fail --silent --show-error --location --retry 3 -o - "$2" \
    | head -c "$((MAX_DOWNLOAD_BYTES + 1))" > "$1" || status=$?
  if [ "$(wc -c < "$1")" -gt "$MAX_DOWNLOAD_BYTES" ]; then
    echo "install-woff2.sh: $2 is larger than $MAX_DOWNLOAD_BYTES bytes" >&2
    exit 1
  fi
  if [ "$status" -ne 0 ]; then
    echo "install-woff2.sh: the download of $2 failed (status $status)" >&2
    exit 1
  fi
}

WOFF2_URL="https://github.com/google/woff2/archive/${WOFF2_COMMIT}.tar.gz"
BROTLI_URL="https://github.com/google/brotli/archive/${BROTLI_COMMIT}.tar.gz"
fetch "$work/woff2.tar.gz" "$WOFF2_URL"
echo "${WOFF2_SHA256}  $work/woff2.tar.gz" | sha256sum --check --strict -
fetch "$work/brotli.tar.gz" "$BROTLI_URL"
echo "${BROTLI_SHA256}  $work/brotli.tar.gz" | sha256sum --check --strict -

# The Brotli tree goes where the woff2 Makefile looks for its submodule.
src="$work/woff2"
mkdir -p "$src/brotli"
tar -xzf "$work/woff2.tar.gz" -C "$src" --strip-components=1
tar -xzf "$work/brotli.tar.gz" -C "$src/brotli" --strip-components=1
test -f "$src/brotli/c/include/brotli/encode.h"

jobs="$(nproc 2> /dev/null || echo 2)"
# The Makefile appends its own flags to CFLAGS and CXXFLAGS taken from the environment.
(cd "$src" && CFLAGS="$BUILD_FLAGS" CXXFLAGS="$BUILD_FLAGS" make -j"$jobs" woff2_compress woff2_decompress > "$work/make.log" 2>&1) \
  || { tail -n 40 "$work/make.log" >&2; exit 1; }

install -d "$INSTALL_DIR/bin" "$INSTALL_DIR/share/doc/woff2"
install -m 0755 "$src/woff2_compress" "$INSTALL_DIR/bin/woff2_compress"
install -m 0755 "$src/woff2_decompress" "$INSTALL_DIR/bin/woff2_decompress"
# The Debian-style name, so the image collects it into /licenses with the system notices: the woff2 text, then the Brotli text.
{
  printf 'woff2 (https://github.com/google/woff2, commit %s)\n\n' "$WOFF2_COMMIT"
  cat "$src/LICENSE"
  printf '\n\nBrotli %s (https://github.com/google/brotli, commit %s)\n\n' "$BROTLI_VERSION" "$BROTLI_COMMIT"
  cat "$src/brotli/LICENSE"
} > "$INSTALL_DIR/share/doc/woff2/copyright"
chmod 0644 "$INSTALL_DIR/share/doc/woff2/copyright"
compress_digest="$(sha256sum "$INSTALL_DIR/bin/woff2_compress" | cut -d' ' -f1)"
decompress_digest="$(sha256sum "$INSTALL_DIR/bin/woff2_decompress" | cut -d' ' -f1)"
printf 'woff2_compress and woff2_decompress (google/woff2 commit %s, with Brotli %s, commit %s), built here from the unmodified sources with the make rules of the woff2 tree and the added flags: %s\nSHA-256 woff2_compress %s\nSHA-256 woff2_decompress %s\nSource: %s (SHA-256 %s) and %s (SHA-256 %s)\n' \
  "$WOFF2_COMMIT" "$BROTLI_VERSION" "$BROTLI_COMMIT" "${BUILD_FLAGS:-none}" "$compress_digest" "$decompress_digest" \
  "$WOFF2_URL" "$WOFF2_SHA256" "$BROTLI_URL" "$BROTLI_SHA256" > "$INSTALL_DIR/share/doc/woff2/SOURCE"

if [ "$(id -u)" -eq 0 ] && [ "$INSTALL_DIR" != "/usr/local" ]; then
  ln -sf "$INSTALL_DIR/bin/woff2_compress" /usr/local/bin/woff2_compress
  ln -sf "$INSTALL_DIR/bin/woff2_decompress" /usr/local/bin/woff2_decompress
fi
echo "woff2_compress $compress_digest"
echo "woff2_decompress $decompress_digest"
