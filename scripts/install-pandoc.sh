#!/usr/bin/env bash
# Installs the pinned pandoc release program, the converter of Markdown, plain text and HTML to LaTeX and of Markdown to reStructuredText
# (entry 309 of docs/policy-decisions.md). pandoc (John MacFarlane and contributors) is GPL-2.0-or-later; the program is the project's own
# statically linked Linux release from its release page, used unmodified and only as a separate program that the worker starts in the
# process sandbox: it is never linked into the application and no code of it is copied. The archive and the licence files are each verified
# against a fixed SHA-256 before anything in them runs or is copied, and the licence files come from the tagged commit, not a branch.
#
# Bump PANDOC_VERSION, PANDOC_COMMIT (the commit the tag names) and the digests together, and run tests/pandoc-pairs.test.ts with the new
# program before moving the pin. The version is the reference converter's (3.1.11), so that the output of a pair is the one the reference writes.
#
# Usage: install-pandoc.sh [install-dir]   (default /opt/pandoc; linux x86_64 or aarch64; needs curl, tar and sha256sum)
# Installs <install-dir>/bin/pandoc (the release program is about 160 MB; `pandoc-lua` and `pandoc-server` of the archive are links to it and
# are not installed), the licence text and the copyright notice of the program and the libraries linked into it at
# <install-dir>/share/doc/pandoc/copyright and COPYRIGHT, and a SOURCE note beside them, and links the program into /usr/local/bin when it is
# run as root and the directory is not /usr/local.
set -euo pipefail

PANDOC_VERSION="3.1.11"
PANDOC_COMMIT="c3038dcd54152c4e18e49db31676b79ee7cc29b2"
PANDOC_SHA256_AARCH64="d7737918fa30377783df0c7f6b7e6bdbbea9607c9c2f0b5ee6e473647a3194a5"
PANDOC_SHA256_X86_64="c573fc25bc0880879bfff9a929a2a9c6834a6c5e4d7d1669fb23eddeaef37937"
PANDOC_LICENSE_SHA256="e7ea3adeab955103a837b692ca0017cb3abbed0d3dccbfa499d6b2b825d698c3"
PANDOC_COPYRIGHT_SHA256="d08e01a4da8ec37b4645a1708483d8845731b5760b411d12736c648de8ccdc21"
# The release archive is about 34 MB. curl refuses a download whose announced size is larger, and fetch stops reading at the bound
# plus one byte whatever the server announces, so that nothing larger than the bound is written before its digest is checked.
MAX_DOWNLOAD_BYTES=$((64 * 1024 * 1024))
INSTALL_DIR="${1:-/opt/pandoc}"

# The pinned programs are Linux builds; elsewhere (macOS reports arm64 too) there is nothing to install.
if [ "$(uname -s)" != "Linux" ]; then
  echo "install-pandoc.sh: the pinned pandoc builds are for Linux, not $(uname -s)" >&2
  exit 1
fi
case "$(uname -m)" in
  aarch64 | arm64)
    target="arm64"
    digest="$PANDOC_SHA256_AARCH64"
    ;;
  x86_64 | amd64)
    target="amd64"
    digest="$PANDOC_SHA256_X86_64"
    ;;
  *)
    echo "install-pandoc.sh: no pinned pandoc build for $(uname -m)" >&2
    exit 1
    ;;
esac
PANDOC_URL="https://github.com/jgm/pandoc/releases/download/${PANDOC_VERSION}/pandoc-${PANDOC_VERSION}-linux-${target}.tar.gz"
PANDOC_RAW_URL="https://raw.githubusercontent.com/jgm/pandoc/${PANDOC_COMMIT}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fetch() {
  local status=0
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --max-filesize "$MAX_DOWNLOAD_BYTES" --fail --silent --show-error --location --retry 6 --retry-delay 10 -o - "$2" \
    | head -c "$((MAX_DOWNLOAD_BYTES + 1))" > "$1" || status=$?
  if [ "$(wc -c < "$1")" -gt "$MAX_DOWNLOAD_BYTES" ]; then
    echo "install-pandoc.sh: $2 is larger than $MAX_DOWNLOAD_BYTES bytes" >&2
    exit 1
  fi
  if [ "$status" -ne 0 ]; then
    echo "install-pandoc.sh: the download of $2 failed (status $status)" >&2
    exit 1
  fi
}

# With PANDOC_DOWNLOADS set (CI), a download kept there from an earlier run is used when its digest still matches, and a fresh
# one is kept there for the next run. The digest is checked on every use either way.
cached_fetch() {
  local name="$1" url="$2" sum="$3"
  if [ -n "${PANDOC_DOWNLOADS:-}" ] && echo "${sum}  ${PANDOC_DOWNLOADS}/${name}" | sha256sum --check --strict --status - 2>/dev/null; then
    cp "${PANDOC_DOWNLOADS}/${name}" "$work/${name}"
  else
    fetch "$work/${name}" "$url"
  fi
  echo "${sum}  $work/${name}" | sha256sum --check --strict -
  if [ -n "${PANDOC_DOWNLOADS:-}" ]; then cp "$work/${name}" "${PANDOC_DOWNLOADS}/${name}"; fi
}

cached_fetch "pandoc-${PANDOC_VERSION}-linux-${target}.tar.gz" "$PANDOC_URL" "$digest"
mv "$work/pandoc-${PANDOC_VERSION}-linux-${target}.tar.gz" "$work/pandoc.tar.gz"
cached_fetch "COPYING.md-${PANDOC_COMMIT}" "${PANDOC_RAW_URL}/COPYING.md" "$PANDOC_LICENSE_SHA256"
cached_fetch "COPYRIGHT-${PANDOC_COMMIT}" "${PANDOC_RAW_URL}/COPYRIGHT" "$PANDOC_COPYRIGHT_SHA256"
tar -xzf "$work/pandoc.tar.gz" -C "$work" --strip-components=2 "pandoc-${PANDOC_VERSION}/bin/pandoc"

install -d "$INSTALL_DIR/bin" "$INSTALL_DIR/share/doc/pandoc"
install -m 0755 "$work/pandoc" "$INSTALL_DIR/bin/pandoc"
# The Debian-style name, so the image collects it into /licenses with the system notices.
install -m 0644 "$work/COPYING.md-${PANDOC_COMMIT}" "$INSTALL_DIR/share/doc/pandoc/copyright"
install -m 0644 "$work/COPYRIGHT-${PANDOC_COMMIT}" "$INSTALL_DIR/share/doc/pandoc/COPYRIGHT"
printf 'pandoc %s (John MacFarlane and contributors), unmodified release program %s\nSHA-256 %s\nSource: https://github.com/jgm/pandoc/tree/%s\n' \
  "$PANDOC_VERSION" "$PANDOC_URL" "$digest" "$PANDOC_COMMIT" > "$INSTALL_DIR/share/doc/pandoc/SOURCE"

if [ "$(id -u)" -eq 0 ] && [ "$INSTALL_DIR" != "/usr/local" ]; then
  ln -sf "$INSTALL_DIR/bin/pandoc" /usr/local/bin/pandoc
fi
"$INSTALL_DIR/bin/pandoc" --version | head -n 1
