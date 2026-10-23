#!/usr/bin/env bash
# The build container of sharp-libvips: the RUN step of the upstream platform Dockerfile (platforms/linux-x64/Dockerfile or
# platforms/linux-arm64v8/Dockerfile at UPSTREAM_SHA), with the releases that float there pinned in env.sh, and the
# upstream sources at that commit unpacked into /packaging, where build/posix.sh expects them. The build fails if the
# archive or the upstream Dockerfile is not the one pinned, so a new release cannot be built before this script is compared
# with its Dockerfile.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/env.sh"

fetch() {
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --silent --show-error --location --retry 3 --output "$2" "$1"
  echo "$3  $2" | sha256sum --check --strict -
}

dnf update -y
dnf install -y epel-release
dnf config-manager --set-enabled powertools
# PLATFORM_PACKAGES is left unquoted: it is empty on arm64.
dnf install -y --setopt=tsflags=nodocs \
  autoconf \
  automake \
  bzip2 \
  cmake \
  curl-devel \
  findutils \
  "gcc-toolset-15-gcc-${GCC_TOOLSET_RELEASE}" \
  "gcc-toolset-15-gcc-c++-${GCC_TOOLSET_RELEASE}" \
  gettext \
  git \
  gperf \
  jq \
  make \
  $PLATFORM_PACKAGES \
  openssl-devel \
  patch \
  pkgconf \
  python3.12-pip \
  tar \
  xz
dnf clean all

fetch "https://github.com/lovell/sharp-libvips/archive/${UPSTREAM_SHA}.tar.gz" /tmp/sharp-libvips.tar.gz "$UPSTREAM_ARCHIVE_SHA256"
mkdir /packaging
tar -xzf /tmp/sharp-libvips.tar.gz -C /packaging --strip-components=1
rm /tmp/sharp-libvips.tar.gz
echo "${PLATFORM_DOCKERFILE_SHA256}  /packaging/platforms/${PLATFORM}/Dockerfile" | sha256sum --check --strict -
grep -qx "VERSION_VIPS=${VIPS_VERSION}" /packaging/versions.properties

# The upstream Dockerfile pipes https://sh.rustup.rs into sh, which downloads the newest rustup-init and runs it with these arguments.
fetch "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${RUST_HOST}/rustup-init" /tmp/rustup-init "$RUSTUP_INIT_SHA256"
chmod +x /tmp/rustup-init
/tmp/rustup-init -y --no-modify-path --profile minimal --default-host "$RUST_HOST" --default-toolchain "$RUST_TOOLCHAIN"
rm /tmp/rustup-init
cargo install cargo-c --version "=${CARGO_C_VERSION}" --locked
pip3.12 install --no-cache-dir --require-hashes --only-binary=:all: -r "$here/requirements.txt"

gcc --version | head -n 1
rustc --version
meson --version
