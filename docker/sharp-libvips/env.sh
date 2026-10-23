# Pins and environment of the sharp libvips build (the sharplibvips-build stage of Dockerfile.worker), sourced by the scripts
# of this directory (docs/policy-decisions.md, entry 84).
#
# The build is the upstream sharp-libvips release that the @img/sharp-libvips-linux-* package of package-lock.json is made
# from, at that release's commit. A sharp upgrade that brings another release fails check-sharp.sh until these pins move
# with it: UPSTREAM_SHA and its archive digest, SHARP_LIBVIPS_VERSION, VIPS_VERSION, the platform Dockerfile digests below
# (after the toolchain script is compared with the new Dockerfiles), sources.sha256, and the two patches.

# sharp-libvips v1.3.4, the release sharp 0.35.5 installs. The archive is GitHub's tarball of the commit.
SHARP_LIBVIPS_VERSION=1.3.4
UPSTREAM_SHA=ebb95f8add54eee8bed840e3fb587e4cbec857d7
UPSTREAM_ARCHIVE_SHA256=65fdb633c2d97626352a3771b7a0ce30b6a89af03d2a1238491c8b068e6b8dad
VIPS_VERSION=8.18.7

# The parts of the upstream build container that float: the upstream Dockerfile installs the newest gcc-toolset-15, the
# newest Rust nightly through the newest rustup, and the newest cargo-c, meson and ninja. These are the releases the
# x64 run of 2026-10-23 measured (the nightly of that date is rustc 1.101.0-nightly 7189d39d9 2026-10-22).
GCC_TOOLSET_RELEASE=15.2.1-7.1.el8_10
RUST_TOOLCHAIN=nightly-2026-10-23
RUSTUP_VERSION=1.29.2
CARGO_C_VERSION=0.10.26

# What differs between the two upstream platform Dockerfiles (platforms/linux-x64 and platforms/linux-arm64v8).
case "$(uname -m)" in
  x86_64)
    PLATFORM=linux-x64
    NPM_ARCH=x64
    RUST_HOST=x86_64-unknown-linux-gnu
    RUSTUP_INIT_SHA256=5be191e8c70a5007074254cb74d78dbfdd25cd5a61c27de7b8e5410122ec24f4
    PLATFORM_DOCKERFILE_SHA256=1e8bc3981c8f1718cd99ea4fcd6d2e511afb9969f2fe3e0d2dc1ebf5a338a6e3
    PLATFORM_PACKAGES=nasm
    PLATFORM_FLAGS=-march=nehalem
    PKGCONF_WRAPPER=x86_64-linux-gnu-pkgconf
    ;;
  aarch64)
    PLATFORM=linux-arm64v8
    NPM_ARCH=arm64
    RUST_HOST=aarch64-unknown-linux-gnu
    RUSTUP_INIT_SHA256=a9c168dbea81a84671c6b7a5c1795cb0eb699020110d107ddfca427bd797e697
    PLATFORM_DOCKERFILE_SHA256=1ba128aaa15a894fcecc2efbc801cd3eae4beaefbf9caecdb2ce35d1102a16c4
    PLATFORM_PACKAGES=
    PLATFORM_FLAGS=-march=armv8-a
    PKGCONF_WRAPPER=aarch64-linux-gnu-pkgconf
    ;;
  *)
    echo "no sharp libvips build for $(uname -m)" >&2
    return 1
    ;;
esac

# The "Path settings" of the upstream Dockerfile.
export RUSTUP_HOME=/usr/local/rustup
export CARGO_HOME=/usr/local/cargo
export PATH="/usr/local/cargo/bin:/opt/rh/gcc-toolset-15/root/usr/bin:$PATH"

# The "Compiler settings" of the upstream Dockerfile, which it sets after the toolchain is installed.
export_compiler_settings() {
  export PKG_CONFIG="$PKGCONF_WRAPPER --static"
  export PLATFORM
  export FLAGS="$PLATFORM_FLAGS"
  export RUSTFLAGS="-Zlocation-detail=none -Zfmt-debug=none"
  export MESON="--cross-file=/root/meson.ini"
}
