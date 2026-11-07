#!/usr/bin/env bash
# Builds the vtracer command-line front-end that reads raw RGBA pixels (scripts/vtracer-pixels, copied from the pinned vtracer source, see
# its SOURCE file) and installs it as a separate program. vtracer (visioncortex) is MIT OR Apache-2.0. The worker decodes an upload itself,
# so this program never sees uploaded bytes (docs/policy-decisions.md, entries 142 and 171); the release program of install-vtracer.sh stays
# the fallback for a worker without it.
#
# The program is built for the musl target, as vtracer's own release programs are, and is one static file. That is not a matter of taste:
# the SVG is only the same bytes as the release program's if the floating-point functions of the C library are the same ones. A build
# against glibc, otherwise the same, wrote other bytes for 15 of 36 traces of the benchmark pictures (its math library rounds some
# results differently in the last bit); tests/raster-vectorize-pixels.test.ts compares the two programs.
#
# Everything that decides the bytes of the program is pinned: the Rust toolchain by version, with the SHA-256 of each of its four
# component archives for both architectures (checked before anything in them runs), and every crate by the checksum in Cargo.lock
# (`cargo build --locked` refuses a lockfile that has to change). The toolchain is unpacked next to the build and removed with it, and the
# build runs with its own CARGO_HOME, so nothing of the host's Rust (or its absence) matters. The one C file that is compiled, the
# allocator (mimalloc, a crate of the lockfile), is compiled by the C compiler of the host, so the digest of the program is printed and
# written to the SOURCE file but not pinned here: it is the same when the build is repeated on the same image, and another compiler
# release may write other machine code for it.
#
# Bump RUST_VERSION and the eight digests together (the .sha256 files beside each archive on static.rust-lang.org give them), and run
# tests/raster-vectorize-pixels.test.ts with the new program before moving the pin.
#
# Usage: install-vtracer-pixels.sh [install-dir]   (default /opt/vtracer-pixels; linux x86_64 or aarch64; needs a C compiler (gcc), curl,
# tar, xz and sha256sum)
# Installs <install-dir>/bin/vtracer-pixels with the licence text at <install-dir>/share/doc/vtracer-pixels/copyright, the notices of the
# vtracer program beside it (a superset of what this program links), the notice of the allocator and a SOURCE note, and links the program into /usr/local/bin when it
# is run as root and the directory is not /usr/local.
set -euo pipefail

RUST_VERSION="1.98.1"
RUSTC_SHA256_AARCH64="89fb83041993b48816514815606f53a5264729b8b449671a6b291e6f0ae74f40"
CARGO_SHA256_AARCH64="c09425a7f300af148c0bdfded0e7d5f1fe7c075b2b9674e8935afa769297b2f6"
RUST_STD_SHA256_AARCH64="9bf796a6ec5b004813ebd0b650775a7c6a4f3aae97ad362ae294798dca4f3b23"
RUST_STD_MUSL_SHA256_AARCH64="7e0ad2e67817f224b7a6331e48d6397303fc050edaccf81784ed786ffddc884a"
RUSTC_SHA256_X86_64="e974f036b28565f37c0f3bd92ddefa809bee16c04f9dcf07b9ed96e05aaaf7c4"
CARGO_SHA256_X86_64="ea1de9f9e23107d97ee2b41a72c552f34064a593da503789218387aee59f3ba4"
RUST_STD_SHA256_X86_64="fa3ff450172a16c026944030230c5069947af93c728d9179971d44e5e0cfb561"
RUST_STD_MUSL_SHA256_X86_64="bd9f35880de21dab0e387e84009c00001ae7836a4ba565cb16823f13f75f325f"
# The largest component archive is about 80 MB. curl refuses a download whose announced size is larger, and fetch stops reading at the
# bound plus one byte whatever the server announces, so that nothing larger than the bound is written before its digest is checked.
MAX_DOWNLOAD_BYTES=$((128 * 1024 * 1024))
INSTALL_DIR="${1:-/opt/vtracer-pixels}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_dir="$here/vtracer-pixels"
notices="$here/vtracer-notices/THIRD-PARTY-NOTICES"

if [ "$(uname -s)" != "Linux" ]; then
  echo "install-vtracer-pixels.sh: the pinned toolchain is for Linux, not $(uname -s)" >&2
  exit 1
fi
case "$(uname -m)" in
  aarch64 | arm64)
    host="aarch64-unknown-linux-gnu"
    target="aarch64-unknown-linux-musl"
    rustc_digest="$RUSTC_SHA256_AARCH64"
    cargo_digest="$CARGO_SHA256_AARCH64"
    rust_std_digest="$RUST_STD_SHA256_AARCH64"
    rust_std_musl_digest="$RUST_STD_MUSL_SHA256_AARCH64"
    ;;
  x86_64 | amd64)
    host="x86_64-unknown-linux-gnu"
    target="x86_64-unknown-linux-musl"
    rustc_digest="$RUSTC_SHA256_X86_64"
    cargo_digest="$CARGO_SHA256_X86_64"
    rust_std_digest="$RUST_STD_SHA256_X86_64"
    rust_std_musl_digest="$RUST_STD_MUSL_SHA256_X86_64"
    ;;
  *)
    echo "install-vtracer-pixels.sh: no pinned toolchain for $(uname -m)" >&2
    exit 1
    ;;
esac
command -v cc > /dev/null || { echo "install-vtracer-pixels.sh: a C compiler (cc) is needed to link the program" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fetch() {
  local status=0
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --max-filesize "$MAX_DOWNLOAD_BYTES" --fail --silent --show-error --location --retry 3 -o - "$2" \
    | head -c "$((MAX_DOWNLOAD_BYTES + 1))" > "$1" || status=$?
  if [ "$(wc -c < "$1")" -gt "$MAX_DOWNLOAD_BYTES" ]; then
    echo "install-vtracer-pixels.sh: $2 is larger than $MAX_DOWNLOAD_BYTES bytes" >&2
    exit 1
  fi
  if [ "$status" -ne 0 ]; then
    echo "install-vtracer-pixels.sh: the download of $2 failed (status $status)" >&2
    exit 1
  fi
}

# One component of the toolchain for a system: its archive checked against the pinned digest, then installed into the toolchain directory.
toolchain="$work/toolchain"
install_component() {
  local name="$1" digest="$2" system="$3"
  local archive="$name-$RUST_VERSION-$system"
  fetch "$work/$archive.tar.xz" "https://static.rust-lang.org/dist/$archive.tar.xz"
  echo "${digest}  $work/$archive.tar.xz" | sha256sum --check --strict -
  tar -xJf "$work/$archive.tar.xz" -C "$work"
  "$work/$archive/install.sh" --prefix="$toolchain" --disable-ldconfig > /dev/null
  rm -rf "${work:?}/$archive" "${work:?}/$archive.tar.xz"
}
install_component rustc "$rustc_digest" "$host"
install_component cargo "$cargo_digest" "$host"
# The standard library of the host, for the build scripts and macros that run during the build, and of the target the program is built for.
install_component rust-std "$rust_std_digest" "$host"
install_component rust-std "$rust_std_musl_digest" "$target"
test "$("$toolchain/bin/rustc" --version | cut -d' ' -f2)" = "$RUST_VERSION"

# The build runs on a copy, from a fixed directory name, so that the lockfile is never rewritten in the checkout and the paths the compiler
# records do not depend on where the checkout is (they are also remapped).
cp -R "$source_dir" "$work/src"
export CARGO_HOME="$work/cargo"
export RUSTFLAGS="--remap-path-prefix=$work=/build"
# The allocator is C: compiled with the host's compiler (cc-rs would look for a musl-targeting one), without the hardening defaults of
# some distributions, which call functions of the glibc that the musl target does not have.
target_env="${target//-/_}"
export "CC_${target_env}=cc"
export "CFLAGS_${target_env}=-U_FORTIFY_SOURCE -fno-stack-protector -ffile-prefix-map=$work=/build"
# mimalloc records the time it was compiled (__DATE__ and __TIME__); with this set the compiler writes a fixed one.
export SOURCE_DATE_EPOCH=0
export PATH="$toolchain/bin:$PATH"
(cd "$work/src" && cargo build --release --locked --target "$target" --target-dir "$work/target" --quiet)
program="$work/target/$target/release/vtracer-pixels"
digest="$(sha256sum "$program" | cut -d' ' -f1)"

install -d "$INSTALL_DIR/bin" "$INSTALL_DIR/share/doc/vtracer-pixels"
install -m 0755 "$program" "$INSTALL_DIR/bin/vtracer-pixels"
# The Debian-style name, so the image collects it into /licenses with the system notices.
install -m 0644 "$source_dir/LICENSE" "$INSTALL_DIR/share/doc/vtracer-pixels/copyright"
install -m 0644 "$notices" "$INSTALL_DIR/share/doc/vtracer-pixels/THIRD-PARTY-NOTICES"
install -m 0644 "$source_dir/NOTICE-mimalloc" "$INSTALL_DIR/share/doc/vtracer-pixels/NOTICE-mimalloc"
printf 'vtracer-pixels (vtracer 1.0.0-alpha.4 by visioncortex, command-line front-end copied from commit 2500df76b5aea0ac22d15296b22722442f825c5b), built here from scripts/vtracer-pixels with Rust %s for %s, cargo build --release --locked\nSHA-256 %s\nSource: https://github.com/visioncortex/vtracer/tree/2500df76b5aea0ac22d15296b22722442f825c5b/crates/vtracer-cli and the crates of scripts/vtracer-pixels/Cargo.lock\n' \
  "$RUST_VERSION" "$target" "$digest" > "$INSTALL_DIR/share/doc/vtracer-pixels/SOURCE"

if [ "$(id -u)" -eq 0 ] && [ "$INSTALL_DIR" != "/usr/local" ]; then
  ln -sf "$INSTALL_DIR/bin/vtracer-pixels" /usr/local/bin/vtracer-pixels
fi
echo "vtracer-pixels $digest"
