#!/usr/bin/env bash
# Builds cjpegli, the command-line JPEG encoder of jpegli (google/jpegli, BSD-3-Clause), from pinned source and installs it as a separate
# program. The worker runs it sandboxed and nothing links it into the application (src/lib/conversions/jpegli-cli.ts); the image library's
# own JPEG encoder stays the fallback for a worker without it (docs/policy-decisions.md, entry 231).
#
# jpegli is the libjpeg-compatible encoder of the JPEG XL project (libjxl, which carried it until release 0.11 and moved it to its own
# repository afterwards). The repository has no release tags, so the pin is a commit of its main branch; the archive GitHub makes of that
# commit is checked against its SHA-256 and against the commit it records. The three source trees that its build expects as git
# submodules are pinned the same way, at the commits its tree names (highway: SIMD dispatch, skcms: the colour management of its tools);
# Link-time optimisation is the only change to the build; nothing is patched. The input codec of the tool is the PNM family, which the worker
# writes itself on the standard input: PNG, GIF, JPEG, EXR and sjpeg are left out, which also keeps their parsers (libpng, zlib among them)
# out of the program.
#
# Everything that decides the bytes of the program is pinned: every archive by SHA-256 (checked before anything in it runs), the build
# tool (CMake) by version with the digest of its release archive for both architectures, and the C and C++ compilers by the image the
# build runs in. The digest of the program is printed and written to the SOURCE file but not pinned here.
#
# Bump a commit and its digest together, and run tests/image-jpegli-cli*.test.ts and the image quality benchmark with the new program
# before moving the pin.
#
# Usage: install-cjpegli.sh [install-dir]   (default /opt/cjpegli; linux x86_64 or aarch64; needs gcc and g++ with gcc-ar and gcc-ranlib, make,
# curl, tar, gzip and sha256sum)
# Installs <install-dir>/bin/cjpegli with the licence texts at <install-dir>/share/doc/cjpegli/ (copyright is jpegli's, the others are beside
# it) and a SOURCE note, and links the program into /usr/local/bin as cjpegli-pinned when it is run as root and the directory is not /usr/local.
set -euo pipefail

CMAKE_VERSION="3.31.12"
CMAKE_SHA256_AARCH64="83f8fd91d2038a56556e1400390fcfe42f79602940c494f6c6f1cdae7f9e7f40"
CMAKE_SHA256_X86_64="0dc2e9a6860f06bf10bd8fadc03e35d9eeb4df46e33763a7e480e987758f385c"
JPEGLI_COMMIT="031a0077f5799a6041004267fc12b956c1f52a20"
JPEGLI_SHA256="269b3a75d6b2da2351f7fb2d642043f60f9b6d1bd5839f20c0d7c569be073367"
HWY_COMMIT="271a9a0ed9de1232d9117f1572c3fe28f8542ec1"
HWY_SHA256="c42bcfe44d100223ea0043acb3da6de703103ca44bfb1d46b577c90939177f5f"
LJT_COMMIT="8ecba3647edb6dd940463fedf38ca33a8e2a73d1"
LJT_SHA256="ed729127097af5000bfeddc6b3e679c4363bb1618ebfc07efb6b47f576471b4b"
SKCMS_COMMIT="96d9171c94b937a1b5f0293de7309ac16311b722"
SKCMS_SHA256="9bb4b5bba0b7c04f6c2bce9ff713d61e23c9a20c4945161ae16290498ad74627"
# The largest archive is about 45 MB (CMake). curl refuses a download whose announced size is larger, and fetch stops reading at the bound
# plus one byte whatever the server announces, so that nothing larger than the bound is written before its digest is checked.
MAX_DOWNLOAD_BYTES=$((96 * 1024 * 1024))
INSTALL_DIR="${1:-/opt/cjpegli}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_note="$here/cjpegli/SOURCE"

if [ "$(uname -s)" != "Linux" ]; then
  echo "install-cjpegli.sh: the pinned build is for Linux, not $(uname -s)" >&2
  exit 1
fi
case "$(uname -m)" in
  aarch64 | arm64)
    cmake_system="linux-aarch64"
    cmake_digest="$CMAKE_SHA256_AARCH64"
    ;;
  x86_64 | amd64)
    cmake_system="linux-x86_64"
    cmake_digest="$CMAKE_SHA256_X86_64"
    ;;
  *)
    echo "install-cjpegli.sh: no pinned build for $(uname -m)" >&2
    exit 1
    ;;
esac
for tool in gcc g++ gcc-ar gcc-ranlib make curl tar gzip sha256sum; do
  command -v "$tool" > /dev/null || { echo "install-cjpegli.sh: $tool is needed" >&2; exit 1; }
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fetch() {
  local status=0
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --max-filesize "$MAX_DOWNLOAD_BYTES" --fail --silent --show-error --location --retry 3 -o - "$2" \
    | head -c "$((MAX_DOWNLOAD_BYTES + 1))" > "$1" || status=$?
  if [ "$(wc -c < "$1")" -gt "$MAX_DOWNLOAD_BYTES" ]; then
    echo "install-cjpegli.sh: $2 is larger than $MAX_DOWNLOAD_BYTES bytes" >&2
    exit 1
  fi
  if [ "$status" -ne 0 ]; then
    echo "install-cjpegli.sh: the download of $2 failed (status $status)" >&2
    exit 1
  fi
}

# An archive downloaded, checked against its pinned digest, and unpacked into <work>/<name> without its top directory. An archive that
# GitHub made from a commit or a tag (git archive) records the commit it was made from, which is checked as well when the caller names one.
unpack() {
  local name="$1" url="$2" digest="$3" commit="${4:-}" archive="$work/download"
  fetch "$archive" "$url"
  echo "${digest}  ${archive}" | sha256sum --check --strict -
  if [ -n "$commit" ] && ! grep -aq "comment=$commit" < <(gzip -dc "$archive" | head -c 2048); then
    echo "install-cjpegli.sh: $url was not made from commit $commit" >&2
    exit 1
  fi
  mkdir -p "$work/$name"
  tar -xf "$archive" -C "$work/$name" --strip-components=1
  rm -f "$archive"
}

unpack cmake "https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}/cmake-${CMAKE_VERSION}-${cmake_system}.tar.gz" "$cmake_digest"
cmake="$work/cmake/bin/cmake"
test "$("$cmake" --version | head -n 1)" = "cmake version ${CMAKE_VERSION}"
unpack jpegli "https://github.com/google/jpegli/archive/${JPEGLI_COMMIT}.tar.gz" "$JPEGLI_SHA256" "$JPEGLI_COMMIT"
unpack jpegli/third_party/highway "https://github.com/google/highway/archive/${HWY_COMMIT}.tar.gz" "$HWY_SHA256" "$HWY_COMMIT"
unpack jpegli/third_party/libjpeg-turbo "https://github.com/libjpeg-turbo/libjpeg-turbo/archive/${LJT_COMMIT}.tar.gz" "$LJT_SHA256" "$LJT_COMMIT"
unpack jpegli/third_party/skcms "https://github.com/google/skcms/archive/${SKCMS_COMMIT}.tar.gz" "$SKCMS_SHA256" "$SKCMS_COMMIT"

prefix="$work/prefix"
# The same paths are recorded whatever the checkout and the temporary directory are.
export SOURCE_DATE_EPOCH=0
export CFLAGS="-ffile-prefix-map=$work=/build"
export CXXFLAGS="-ffile-prefix-map=$work=/build"
jobs="$(nproc)"
# Link-time optimisation for every library and the program (see install-avifenc.sh): the machine code is the same program, the files do not change.
lto="-flto=$jobs -fno-fat-lto-objects"
common=(-G "Unix Makefiles" -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$prefix" -DCMAKE_INSTALL_LIBDIR=lib -DCMAKE_PREFIX_PATH="$prefix"
  -DBUILD_SHARED_LIBS=OFF -DCMAKE_POSITION_INDEPENDENT_CODE=ON
  -DCMAKE_C_FLAGS_RELEASE="-O3 -DNDEBUG $lto" -DCMAKE_CXX_FLAGS_RELEASE="-O3 -DNDEBUG $lto"
  -DCMAKE_AR="$(command -v gcc-ar)" -DCMAKE_RANLIB="$(command -v gcc-ranlib)")

# Configures a library, builds it (all of it, or only the target named by TARGET) and installs it into the prefix (a library; not when a target is named).
build() {
  local name="$1"
  shift
  "$cmake" -S "$work/$name" -B "$work/build-$name" "${common[@]}" "$@" > "$work/$name.log" 2>&1 || { cat "$work/$name.log" >&2; exit 1; }
  "$cmake" --build "$work/build-$name" --parallel "$jobs" ${TARGET:+--target "$TARGET"} >> "$work/$name.log" 2>&1 || { tail -n 60 "$work/$name.log" >&2; exit 1; }
  if [ -z "${TARGET:-}" ]; then "$cmake" --install "$work/build-$name" >> "$work/$name.log" 2>&1; fi
}

TARGET=cjpegli build jpegli -DJPEGLI_VERSION="0.12.0-${JPEGLI_COMMIT:0:10}" -DJPEGLI_ENABLE_SKCMS=ON -DJPEGLI_ENABLE_SJPEG=OFF -DJPEGLI_ENABLE_OPENEXR=OFF \
  -DJPEGLI_ENABLE_FUZZERS=OFF -DJPEGLI_ENABLE_DEVTOOLS=OFF -DJPEGLI_ENABLE_BENCHMARK=OFF -DJPEGLI_ENABLE_JNI=OFF -DJPEGLI_ENABLE_DOXYGEN=OFF \
  -DJPEGLI_ENABLE_MANPAGES=OFF -DJPEGLI_ENABLE_JPEGLI_LIBJPEG=OFF -DJPEGLI_ENABLE_TCMALLOC=OFF -DJPEGLI_BUNDLE_LIBPNG=OFF -DBUILD_TESTING=OFF \
  -DCMAKE_DISABLE_FIND_PACKAGE_PNG=ON -DCMAKE_DISABLE_FIND_PACKAGE_GIF=ON -DCMAKE_DISABLE_FIND_PACKAGE_JPEG=ON -DCMAKE_DISABLE_FIND_PACKAGE_PkgConfig=ON \
  -DCMAKE_EXE_LINKER_FLAGS="-static-libstdc++ -static-libgcc $lto"
program="$work/build-jpegli/tools/cjpegli"
test -x "$program"
digest="$(sha256sum "$program" | cut -d' ' -f1)"
"$program" --help 2>&1 | grep -q 'cjpegli'

install -d "$INSTALL_DIR/bin" "$INSTALL_DIR/share/doc/cjpegli"
install -m 0755 "$program" "$INSTALL_DIR/bin/cjpegli"
doc="$INSTALL_DIR/share/doc/cjpegli"
# The Debian-style name, so the image collects jpegli's licence into /licenses with the system notices.
install -m 0644 "$work/jpegli/LICENSE" "$doc/copyright"
install -m 0644 "$work/jpegli/PATENTS" "$doc/PATENTS"
install -m 0644 "$work/jpegli/third_party/highway/LICENSE" "$doc/LICENSE.highway"
install -m 0644 "$work/jpegli/third_party/skcms/LICENSE" "$doc/LICENSE.skcms"
install -m 0644 "$work/jpegli/third_party/libjpeg-turbo/LICENSE.md" "$doc/LICENSE.libjpeg-turbo"
install -m 0644 "$work/jpegli/third_party/libjpeg-turbo/README.ijg" "$doc/README.ijg"
install -m 0644 "$source_note" "$doc/SOURCE"
printf 'SHA-256 of the program built here: %s\n' "$digest" >> "$doc/SOURCE"

if [ "$(id -u)" -eq 0 ] && [ "$INSTALL_DIR" != "/usr/local" ]; then
  ln -sf "$INSTALL_DIR/bin/cjpegli" /usr/local/bin/cjpegli-pinned
fi
echo "cjpegli $digest"
