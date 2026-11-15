#!/usr/bin/env bash
# Installs the pinned release program of libvmaf (Netflix/vmaf), the VMAF scorer of the video quality benchmark (bench/measure.ts,
# measureVmaf). libvmaf is BSD-2-Clause-Patent; the program is the project's own Linux build from its release page, used unmodified
# as a separate program for measuring only. It is not linked into the application and not installed in the product image. The
# model is the one compiled into the program (vmaf_v0.6.1), so no model file is fetched. The archive and the licence text are each
# verified against a fixed SHA-256 before anything in them runs or is copied; the licence text comes from the tagged commit.
#
# Bump VMAF_VERSION, VMAF_COMMIT (the commit the tag names) and the digests together, and run the video family of the benchmark with
# the new program before moving the pin: the reference side of the VMAF rows is cached under the tool fingerprint.
#
# Usage: install-vmaf.sh [install-dir]   (default /opt/vmaf; linux x86_64 or aarch64; needs curl, unzip and sha256sum)
# Installs <install-dir>/bin/vmaf, the licence text at <install-dir>/share/doc/vmaf/copyright with a SOURCE note beside it, and links
# the program into /usr/local/bin when it is run as root and the directory is not /usr/local.
set -euo pipefail

VMAF_VERSION="3.2.1"
VMAF_COMMIT="f85a853692a8c730d0270cd733c8bb30b5b93b7c"
VMAF_SHA256_AARCH64="94fddd3fa6440c68664d0498eb0716ae0808e2bae2ecede767deb6a30753c74e"
VMAF_SHA256_X86_64="c0bb6d354f7009530fab5749e1309bd90f9c45a5a10e90250e6e558c48cfdd02"
VMAF_LICENSE_SHA256="a6fdb51d02b9dfe198e55534bb8047fe6d756eda117f4ff83de98f92c1952710"
# The release archives are about 0.6 MB. curl refuses a download whose announced size is larger, and fetch stops reading at the bound
# plus one byte whatever the server announces, so that nothing larger than the bound is written before its digest is checked.
MAX_DOWNLOAD_BYTES=$((16 * 1024 * 1024))
INSTALL_DIR="${1:-/opt/vmaf}"

if [ "$(uname -s)" != "Linux" ]; then
  echo "install-vmaf.sh: the pinned vmaf builds are for Linux, not $(uname -s)" >&2
  exit 1
fi
case "$(uname -m)" in
  aarch64 | arm64)
    archive="vmaf-linux-arm64-clang.zip"
    digest="$VMAF_SHA256_AARCH64"
    ;;
  x86_64 | amd64)
    archive="vmaf-linux-x86_64-gcc.zip"
    digest="$VMAF_SHA256_X86_64"
    ;;
  *)
    echo "install-vmaf.sh: no pinned vmaf build for $(uname -m)" >&2
    exit 1
    ;;
esac
VMAF_URL="https://github.com/Netflix/vmaf/releases/download/v${VMAF_VERSION}/${archive}"
VMAF_LICENSE_URL="https://raw.githubusercontent.com/Netflix/vmaf/${VMAF_COMMIT}/LICENSE"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fetch() {
  local status=0
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --max-filesize "$MAX_DOWNLOAD_BYTES" --fail --silent --show-error --location --retry 6 --retry-delay 10 -o - "$2" \
    | head -c "$((MAX_DOWNLOAD_BYTES + 1))" > "$1" || status=$?
  if [ "$(wc -c < "$1")" -gt "$MAX_DOWNLOAD_BYTES" ]; then
    echo "install-vmaf.sh: $2 is larger than $MAX_DOWNLOAD_BYTES bytes" >&2
    exit 1
  fi
  if [ "$status" -ne 0 ]; then
    echo "install-vmaf.sh: the download of $2 failed (status $status)" >&2
    exit 1
  fi
}

# With VMAF_DOWNLOADS set (CI), a download kept there from an earlier run is used when its digest still matches, and a fresh
# one is kept there for the next run. The digest is checked on every use either way.
cached_fetch() {
  local name="$1" url="$2" sum="$3"
  if [ -n "${VMAF_DOWNLOADS:-}" ] && echo "${sum}  ${VMAF_DOWNLOADS}/${name}" | sha256sum --check --strict --status - 2>/dev/null; then
    cp "${VMAF_DOWNLOADS}/${name}" "$work/${name}"
  else
    fetch "$work/${name}" "$url"
  fi
  echo "${sum}  $work/${name}" | sha256sum --check --strict -
  if [ -n "${VMAF_DOWNLOADS:-}" ]; then cp "$work/${name}" "${VMAF_DOWNLOADS}/${name}"; fi
}

cached_fetch "$archive" "$VMAF_URL" "$digest"
cached_fetch "LICENSE-${VMAF_COMMIT}" "$VMAF_LICENSE_URL" "$VMAF_LICENSE_SHA256"
unzip -q -j "$work/$archive" vmaf -d "$work"

install -d "$INSTALL_DIR/bin" "$INSTALL_DIR/share/doc/vmaf"
install -m 0755 "$work/vmaf" "$INSTALL_DIR/bin/vmaf"
install -m 0644 "$work/LICENSE-${VMAF_COMMIT}" "$INSTALL_DIR/share/doc/vmaf/copyright"
printf 'vmaf %s (Netflix, Inc.), unmodified release program %s\nSHA-256 %s\nSource: https://github.com/Netflix/vmaf/tree/%s\n' \
  "$VMAF_VERSION" "$VMAF_URL" "$digest" "$VMAF_COMMIT" > "$INSTALL_DIR/share/doc/vmaf/SOURCE"

if [ "$(id -u)" -eq 0 ] && [ "$INSTALL_DIR" != "/usr/local" ]; then
  ln -sf "$INSTALL_DIR/bin/vmaf" /usr/local/bin/vmaf
fi
"$INSTALL_DIR/bin/vmaf" --version
