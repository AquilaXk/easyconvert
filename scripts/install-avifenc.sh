#!/usr/bin/env bash
# Builds avifenc, the command-line encoder of libavif (AOMediaCodec/libavif, BSD-2-Clause), from pinned source and installs it as a separate
# program. The worker runs it sandboxed and nothing links it into the application (src/lib/conversions/avif-cli.ts); the Debian package
# libavif-bin stays the fallback for a worker without it (docs/policy-decisions.md, entry 172).
#
# The sources are the ones the Debian package of the worker image is built from, at the same releases, so that the AVIF file is the one
# the package writes for the same picture and arguments: libavif 1.2.1 and its AV1 encoder libaom 3.12.1 (libavif-bin 1.2.1-1.2 and
# libaom3 3.12.1-1+deb13u1 on Debian 13), libyuv 1904 (the colour conversion libavif uses when it is built with it, as the package is),
# libpng and zlib-ng (the PNG reader) and libjpeg-turbo (libavif's applications will not build without a JPEG reader, which avifenc is never
# given). Every one of them is linked in statically, with libstdc++ and libgcc, so the program needs only the C library of the host.
# libavif is built with the AV1 encoder and decoder of libaom and no other codec, libsharpyuv and libxml2 off, as the package is built. Two things
# are done to the build and none to the sources (docs/policy-decisions.md, entry 172): link-time optimisation, and zlib-ng in its zlib-compatible
# mode instead of zlib, which inflates the PNG faster to the same bytes.
#
# Everything that decides the bytes of the program is pinned: every archive by SHA-256 (checked before anything in it runs), the build
# tool (CMake) by version with the digest of its release archive for both architectures, and the C and C++ compilers by the image the
# build runs in. The digest of the program is printed and written to the SOURCE file but not pinned here: it is the same when the build is
# repeated on the same image, and another compiler release may write other machine code.
#
# Bump a version and its digest together, and run tests/image-avif-cli*.test.ts and the image quality benchmark with the new program
# before moving the pin.
#
# Usage: install-avifenc.sh [install-dir]   (default /opt/avifenc; linux x86_64 or aarch64; needs gcc and g++ with gcc-ar and gcc-ranlib, make,
# perl, curl, tar, gzip, xz and sha256sum)
# Installs <install-dir>/bin/avifenc with the licence texts at <install-dir>/share/doc/avifenc/ (copyright is libavif's, the others are
# beside it) and a SOURCE note, and links the program into /usr/local/bin as avifenc-pinned when it is run as root and the directory
# is not /usr/local.
set -euo pipefail

CMAKE_VERSION="3.31.12"
CMAKE_SHA256_AARCH64="83f8fd91d2038a56556e1400390fcfe42f79602940c494f6c6f1cdae7f9e7f40"
CMAKE_SHA256_X86_64="0dc2e9a6860f06bf10bd8fadc03e35d9eeb4df46e33763a7e480e987758f385c"
AVIF_VERSION="1.2.1"
AVIF_COMMIT="fcb084c9387e367750f5375e462005ce298f57cc"
AVIF_SHA256="9c859c7c12ccb0f407511bfe303e6a7247f5f6738f54852662c6df8048daddf4"
AOM_VERSION="3.12.1"
AOM_SHA256="9e9775180dec7dfd61a79e00bda3809d43891aee6b2e331ff7f26986207ea22e"
YUV_VERSION="1904.20250204"
YUV_SHA256="958aeeefcae957a7503202fd7f210678b81f68286e7cc915c8b97feaf1e2d3ab"
PNG_VERSION="1.6.58"
PNG_SHA256="a9d4df463d36a6e5f9c29bd6f4967312d17e996c1854f3511f833924eb1993cf"
ZLIBNG_VERSION="2.3.3"
ZLIBNG_SHA256="f9c65aa9c852eb8255b636fd9f07ce1c406f061ec19a2e7d508b318ca0c907d1"
NASM_VERSION="2.16.03"
NASM_SHA256="1412a1c760bbd05db026b6c0d1657affd6631cd0a63cddb6f73cc6d4aa616148"
JPEG_VERSION="3.1.3"
JPEG_SHA256="075920b826834ac4ddf97661cc73491047855859affd671d52079c6867c1c6c0"
# The largest archive is about 45 MB (CMake). curl refuses a download whose announced size is larger, and fetch stops reading at the bound
# plus one byte whatever the server announces, so that nothing larger than the bound is written before its digest is checked.
MAX_DOWNLOAD_BYTES=$((96 * 1024 * 1024))
INSTALL_DIR="${1:-/opt/avifenc}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_note="$here/avifenc/SOURCE"

if [ "$(uname -s)" != "Linux" ]; then
  echo "install-avifenc.sh: the pinned build is for Linux, not $(uname -s)" >&2
  exit 1
fi
case "$(uname -m)" in
  aarch64 | arm64)
    cmake_system="linux-aarch64"
    cmake_digest="$CMAKE_SHA256_AARCH64"
    nasm_flag=0
    ;;
  x86_64 | amd64)
    cmake_system="linux-x86_64"
    cmake_digest="$CMAKE_SHA256_X86_64"
    nasm_flag=1
    ;;
  *)
    echo "install-avifenc.sh: no pinned build for $(uname -m)" >&2
    exit 1
    ;;
esac
for tool in gcc g++ gcc-ar gcc-ranlib make perl curl tar gzip xz sha256sum; do
  command -v "$tool" > /dev/null || { echo "install-avifenc.sh: $tool is needed" >&2; exit 1; }
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fetch() {
  local status=0
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --max-filesize "$MAX_DOWNLOAD_BYTES" --fail --silent --show-error --location --retry 3 -o - "$2" \
    | head -c "$((MAX_DOWNLOAD_BYTES + 1))" > "$1" || status=$?
  if [ "$(wc -c < "$1")" -gt "$MAX_DOWNLOAD_BYTES" ]; then
    echo "install-avifenc.sh: $2 is larger than $MAX_DOWNLOAD_BYTES bytes" >&2
    exit 1
  fi
  if [ "$status" -ne 0 ]; then
    echo "install-avifenc.sh: the download of $2 failed (status $status)" >&2
    exit 1
  fi
}

# An archive downloaded, checked against its pinned digest, and unpacked into <work>/<name> without its top directory. An archive that
# GitHub made from a tag (git archive) records the commit it was made from, which is checked as well when the caller names one.
unpack() {
  local name="$1" url="$2" digest="$3" commit="${4:-}" archive="$work/$1.archive"
  fetch "$archive" "$url"
  echo "${digest}  ${archive}" | sha256sum --check --strict -
  if [ -n "$commit" ] && ! grep -aq "comment=$commit" < <(gzip -dc "$archive" | head -c 2048); then
    echo "install-avifenc.sh: $url was not made from commit $commit" >&2
    exit 1
  fi
  mkdir "$work/$name"
  tar -xf "$archive" -C "$work/$name" --strip-components=1
  rm -f "$archive"
}

unpack cmake "https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}/cmake-${CMAKE_VERSION}-${cmake_system}.tar.gz" "$cmake_digest"
cmake="$work/cmake/bin/cmake"
test "$("$cmake" --version | head -n 1)" = "cmake version ${CMAKE_VERSION}"
unpack zlib "https://github.com/zlib-ng/zlib-ng/archive/${ZLIBNG_VERSION}.tar.gz" "$ZLIBNG_SHA256"
unpack png "https://github.com/pnggroup/libpng/archive/v${PNG_VERSION}.tar.gz" "$PNG_SHA256"
unpack jpeg "https://github.com/libjpeg-turbo/libjpeg-turbo/releases/download/${JPEG_VERSION}/libjpeg-turbo-${JPEG_VERSION}.tar.gz" "$JPEG_SHA256"
unpack aom "https://storage.googleapis.com/aom-releases/libaom-${AOM_VERSION}.tar.gz" "$AOM_SHA256"
unpack yuv "https://deb.debian.org/debian/pool/main/liby/libyuv/libyuv_0.0.${YUV_VERSION}.orig.tar.xz" "$YUV_SHA256"
unpack avif "https://github.com/AOMediaCodec/libavif/archive/refs/tags/v${AVIF_VERSION}.tar.gz" "$AVIF_SHA256" "$AVIF_COMMIT"

prefix="$work/prefix"
# The assembler of the x86-64 assembly in libaom and libjpeg-turbo (a Debian 13 package of the same release exists; this one is the pinned
# archive, so that the build needs nothing from the host's package list). It is a build tool: nothing of it is in the program.
if [ "$nasm_flag" -eq 1 ]; then
  unpack nasm "https://www.nasm.us/pub/nasm/releasebuilds/${NASM_VERSION}/nasm-${NASM_VERSION}.tar.xz" "$NASM_SHA256"
  (cd "$work/nasm" && ./configure --prefix="$work/tools" > "$work/nasm.log" 2>&1 && make -j"$(nproc)" >> "$work/nasm.log" 2>&1 && make install >> "$work/nasm.log" 2>&1) \
    || { tail -n 40 "$work/nasm.log" >&2; exit 1; }
  export PATH="$work/tools/bin:$PATH"
fi
# The same paths are recorded whatever the checkout and the temporary directory are.
export SOURCE_DATE_EPOCH=0
export CFLAGS="-ffile-prefix-map=$work=/build"
export CXXFLAGS="-ffile-prefix-map=$work=/build"
jobs="$(nproc)"
# Link-time optimisation for every library and the program: the encoder's functions are in many files, and the linker inlines across them. The
# objects hold only the compiler's intermediate form (-fno-fat-lto-objects), so the archives are made with the compiler's own ar and ranlib,
# which load its plugin. The machine code is the same program: the AVIF files do not change.
lto="-flto=$jobs -fno-fat-lto-objects"
common=(-G "Unix Makefiles" -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$prefix" -DCMAKE_INSTALL_LIBDIR=lib -DCMAKE_PREFIX_PATH="$prefix"
  -DBUILD_SHARED_LIBS=OFF -DCMAKE_POSITION_INDEPENDENT_CODE=ON
  -DCMAKE_C_FLAGS_RELEASE="-O3 -DNDEBUG $lto" -DCMAKE_CXX_FLAGS_RELEASE="-O3 -DNDEBUG $lto"
  -DCMAKE_AR="$(command -v gcc-ar)" -DCMAKE_RANLIB="$(command -v gcc-ranlib)")

build() {
  local name="$1"
  shift
  "$cmake" -S "$work/$name" -B "$work/build-$name" "${common[@]}" "$@" > "$work/$name.log" 2>&1 || { cat "$work/$name.log" >&2; exit 1; }
  "$cmake" --build "$work/build-$name" --parallel "$jobs" >> "$work/$name.log" 2>&1 || { tail -n 60 "$work/$name.log" >&2; exit 1; }
  "$cmake" --install "$work/build-$name" >> "$work/$name.log" 2>&1
}

build zlib -DZLIB_COMPAT=ON -DWITH_GTEST=OFF -DBUILD_TESTING=OFF -DWITH_FUZZERS=OFF
build png -DPNG_SHARED=OFF -DPNG_STATIC=ON -DPNG_TESTS=OFF -DPNG_TOOLS=OFF -DPNG_EXECUTABLES=OFF -DZLIB_ROOT="$prefix"
build jpeg -DENABLE_SHARED=0 -DENABLE_STATIC=1 -DWITH_TURBOJPEG=0 -DWITH_JAVA=0 -DREQUIRE_SIMD=0
build aom -DENABLE_DOCS=0 -DENABLE_TESTS=0 -DENABLE_TESTDATA=0 -DENABLE_TOOLS=0 -DENABLE_EXAMPLES=0 -DENABLE_NASM="$nasm_flag" \
  -DCONFIG_PIC=1 -DCONFIG_WEBM_IO=0
build yuv -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DCMAKE_POLICY_DEFAULT_CMP0069=NEW
# libyuv installs a shared library beside the static one, and the search for -lyuv would take the shared one.
build avif -DAVIF_CODEC_AOM=SYSTEM -DAVIF_LIBYUV=SYSTEM -DLIBYUV_LIBRARY="$prefix/lib/libyuv.a" -DAVIF_JPEG=SYSTEM -DAVIF_ZLIBPNG=SYSTEM -DAVIF_BUILD_APPS=ON -DAVIF_BUILD_TESTS=OFF \
  -DAVIF_BUILD_EXAMPLES=OFF -DAVIF_BUILD_MAN_PAGES=OFF -DAVIF_LIBSHARPYUV=OFF -DAVIF_LIBXML2=OFF \
  -DCMAKE_EXE_LINKER_FLAGS="-static-libstdc++ -static-libgcc $lto"
program="$work/build-avif/avifenc"
test -x "$program"
digest="$(sha256sum "$program" | cut -d' ' -f1)"
"$program" --version | head -n 2 | grep -q "Version: ${AVIF_VERSION} .*aom \[enc/dec\]:v${AOM_VERSION}"

install -d "$INSTALL_DIR/bin" "$INSTALL_DIR/share/doc/avifenc"
install -m 0755 "$program" "$INSTALL_DIR/bin/avifenc"
doc="$INSTALL_DIR/share/doc/avifenc"
# The Debian-style name, so the image collects libavif's licence into /licenses with the system notices.
install -m 0644 "$work/avif/LICENSE" "$doc/copyright"
install -m 0644 "$work/aom/LICENSE" "$doc/LICENSE.libaom"
install -m 0644 "$work/aom/PATENTS" "$doc/PATENTS.libaom"
install -m 0644 "$work/yuv/LICENSE" "$doc/LICENSE.libyuv"
install -m 0644 "$work/yuv/PATENTS" "$doc/PATENTS.libyuv"
install -m 0644 "$work/png/LICENSE" "$doc/LICENSE.libpng"
install -m 0644 "$work/zlib/LICENSE.md" "$doc/LICENSE.zlib-ng"
install -m 0644 "$work/jpeg/LICENSE.md" "$doc/LICENSE.libjpeg-turbo"
install -m 0644 "$work/jpeg/README.ijg" "$doc/README.ijg"
install -m 0644 "$source_note" "$doc/SOURCE"
printf 'SHA-256 of the program built here: %s\n' "$digest" >> "$doc/SOURCE"

if [ "$(id -u)" -eq 0 ] && [ "$INSTALL_DIR" != "/usr/local" ]; then
  ln -sf "$INSTALL_DIR/bin/avifenc" /usr/local/bin/avifenc-pinned
fi
echo "avifenc $digest"
