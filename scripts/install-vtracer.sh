#!/usr/bin/env bash
# Installs the pinned vtracer release program, the tracer of the raster to SVG pairs. vtracer (visioncortex) is MIT OR Apache-2.0;
# the program is the project's own statically linked musl build from its release page, used unmodified and only as a separate
# program: it is never linked into the application. The archive and the licence text are each verified against a fixed SHA-256
# before anything in them runs or is copied, and the licence text comes from the tagged commit, not a branch.
#
# Bump VTRACER_VERSION, VTRACER_COMMIT (the commit the tag names) and the three digests together, and run
# tests/raster-vectorize.test.ts with the new program before moving the pin.
#
# Usage: install-vtracer.sh [install-dir]   (default /opt/vtracer; linux x86_64 or aarch64; needs curl, tar and sha256sum)
# Installs <install-dir>/bin/vtracer, the licence text at <install-dir>/share/doc/vtracer/copyright and a SOURCE note beside it,
# and links the program into /usr/local/bin when it is run as root and the directory is not /usr/local.
set -euo pipefail

VTRACER_VERSION="1.0.0-alpha.4"
VTRACER_COMMIT="2500df76b5aea0ac22d15296b22722442f825c5b"
VTRACER_SHA256_AARCH64="92bcd69792d4ba981c0c37db4bb681df4e1eae6c56b0817c73164656664ec5a8"
VTRACER_SHA256_X86_64="2058f611b48ed49497f78883bde47435531e9e17e3a79428432d1528bdb12e2a"
VTRACER_LICENSE_SHA256="81ee739f355765c110fc89feff14ffffce829901f96ba811fd0b65a41a8636c7"
INSTALL_DIR="${1:-/opt/vtracer}"

case "$(uname -m)" in
  aarch64 | arm64)
    target="aarch64-unknown-linux-musl"
    digest="$VTRACER_SHA256_AARCH64"
    ;;
  x86_64 | amd64)
    target="x86_64-unknown-linux-musl"
    digest="$VTRACER_SHA256_X86_64"
    ;;
  *)
    echo "install-vtracer.sh: no pinned vtracer build for $(uname -m)" >&2
    exit 1
    ;;
esac
VTRACER_URL="https://github.com/visioncortex/vtracer/releases/download/${VTRACER_VERSION}/vtracer-${target}.tar.gz"
VTRACER_LICENSE_URL="https://raw.githubusercontent.com/visioncortex/vtracer/${VTRACER_COMMIT}/LICENSE"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fetch() {
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --retry 3 -o "$1" "$2"
}

fetch "$work/vtracer.tar.gz" "$VTRACER_URL"
echo "${digest}  $work/vtracer.tar.gz" | sha256sum --check --strict -
fetch "$work/LICENSE" "$VTRACER_LICENSE_URL"
echo "${VTRACER_LICENSE_SHA256}  $work/LICENSE" | sha256sum --check --strict -
tar -xzf "$work/vtracer.tar.gz" -C "$work" vtracer

install -d "$INSTALL_DIR/bin" "$INSTALL_DIR/share/doc/vtracer"
install -m 0755 "$work/vtracer" "$INSTALL_DIR/bin/vtracer"
# The Debian-style name, so the image collects it into /licenses with the system notices.
install -m 0644 "$work/LICENSE" "$INSTALL_DIR/share/doc/vtracer/copyright"
printf 'vtracer %s (visioncortex), unmodified release program %s\nSHA-256 %s\nSource: https://github.com/visioncortex/vtracer/tree/%s\n' \
  "$VTRACER_VERSION" "$VTRACER_URL" "$digest" "$VTRACER_COMMIT" > "$INSTALL_DIR/share/doc/vtracer/SOURCE"

if [ "$(id -u)" -eq 0 ] && [ "$INSTALL_DIR" != "/usr/local" ]; then
  ln -sf "$INSTALL_DIR/bin/vtracer" /usr/local/bin/vtracer
fi
"$INSTALL_DIR/bin/vtracer" --version
