#!/usr/bin/env bash
# Builds djvulibre from the Debian 13 source of version 3.5.28 (the upstream archive and the Debian packaging, each pinned by SHA-256),
# with the Debian patches of that packaging and the patches of scripts/djvulibre-patches named in DJVULIBRE_PATCHES, and installs its
# `ddjvu` and `djvused` programs, which draw a DjVu document as a PDF and report its pages (entry 135 of docs/policy-decisions.md).
# djvulibre is GPL-2.0-or-later; the programs are used only as separate programs and are never linked into the application. The library
# is linked into them statically, so they need only the C and C++ libraries, libtiff and libjpeg at run time.
#
# Bump the version, the Debian revision and the two digests together (the files of the source package on
# https://deb.debian.org/debian/pool/main/d/djvulibre/, whose .dsc lists the same SHA-256). The Debian patches are applied in the order of
# their series file, then ours, each with no fuzz, so one that no longer applies fails the build. Before moving the pin, read the new
# release's libdjvu/DjVuImage.cpp and libdjvu/DjVuFile.cpp: a patch whose change the release already holds is dropped from
# DJVULIBRE_PATCHES and its file deleted, and any other is rebased on the new file, which changes its digest here. Then run
# tests/djvu-render.test.ts with this build.
#
# Usage: install-djvulibre.sh [install-dir]   (default /opt/djvulibre)
# Needs a C++ compiler, make, autoconf, automake, libtool, pkg-config, patch, curl, xz, dpkg-buildflags (dpkg-dev) and the development
# packages of libjpeg and libtiff. Installs <install-dir>/bin/{ddjvu,djvused}, their message catalog in <install-dir>/share/djvu and, in
# <install-dir>/share/doc/djvulibre, the licence text (copyright), the source it was built from (SOURCE), the patches, and
# tool-version.txt; links the programs into /usr/local/bin when it is run as root and the directory is not /usr/local. With DJVULIBRE_REFERENCE_DDJVU set to the distribution's ddjvu of the same version, the
# build also fails unless the patched program draws the reference manual of the source archive to the same pixels (needs pdftoppm).
set -euo pipefail

DJVULIBRE_VERSION="3.5.28"
DJVULIBRE_DEBIAN_REVISION="2.2"
DJVULIBRE_ORIG_SHA256="1223b7bf7c8dfe2e290882f3bfb88ba2468b30495a1bf8dfd54dc7e810987887"
DJVULIBRE_DEBIAN_SHA256="93c56218b7ea8d2a3dcec7dc982864ba9f3ece50c2e400003d938c67485d3ef6"
DJVULIBRE_POOL="https://deb.debian.org/debian/pool/main/d/djvulibre"
DJVULIBRE_ORIG="djvulibre_${DJVULIBRE_VERSION}.orig.tar.xz"
DJVULIBRE_DEBIAN="djvulibre_${DJVULIBRE_VERSION}-${DJVULIBRE_DEBIAN_REVISION}.debian.tar.xz"
INSTALL_DIR="${1:-/opt/djvulibre}"

# Our patches, in the order they are applied after Debian's: file name in scripts/djvulibre-patches and its SHA-256.
# image-components-visit-once.patch: libdjvu/DjVuImage.cpp searches each included file once for a page component, so a shared file reached
# through many paths no longer costs one search per path.
# decode-thread-start-failure.patch: libdjvu/DjVuFile.cpp fails the decoding of a file whose thread does not start, instead of waiting for
# it forever.
DJVULIBRE_PATCHES=(
  "image-components-visit-once.patch c6f9e1f9f1117a7b22699e9c9e819b41ed153e3fe0f7233795f798e1bf34eaaa"
  "decode-thread-start-failure.patch 6e0fc09dfe4f90135221244830126d19db6998916d4e782cfa6e28e383875359"
)
patch_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/djvulibre-patches"
# The programs the worker runs; the others the build makes are not installed.
PROGRAMS="ddjvu djvused"
# A chain of shared files that each include the next two: drawn in 0.04 s with the patch and in about 50 s without it.
CHAIN_LEVELS=40
CHAIN_DRAW_SECONDS=10
# A chain of shared files that each include the next, under an address space that holds the stacks of about 64 threads (8 MiB each).
THREAD_CHAIN_LEVELS=100
THREAD_CHAIN_ADDRESS_SPACE=$((512 * 1024 * 1024))

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

for entry in "$DJVULIBRE_ORIG $DJVULIBRE_ORIG_SHA256" "$DJVULIBRE_DEBIAN $DJVULIBRE_DEBIAN_SHA256"; do
  read -r archive archive_sha256 <<< "$entry"
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --retry 3 -o "$work/$archive" "$DJVULIBRE_POOL/$archive"
  echo "${archive_sha256}  $work/$archive" | sha256sum --check --strict -
done
tar -xJf "$work/$DJVULIBRE_ORIG" -C "$work"
source_dir="$work/djvulibre-${DJVULIBRE_VERSION}"
tar -xJf "$work/$DJVULIBRE_DEBIAN" -C "$source_dir"
cd "$source_dir"
while read -r debian_patch; do
  case "$debian_patch" in '' | '#'*) continue ;; esac
  patch -p1 --forward --fuzz=0 --no-backup-if-mismatch --silent --input="debian/patches/${debian_patch}"
done < debian/patches/series
for entry in "${DJVULIBRE_PATCHES[@]}"; do
  read -r patch_name patch_sha256 <<< "$entry"
  echo "${patch_sha256}  ${patch_dir}/${patch_name}" | sha256sum --check --strict -
  patch -p1 --forward --fuzz=0 --no-backup-if-mismatch --input="${patch_dir}/${patch_name}"
done

# The compiler flags of the Debian package (debian/rules: hardening=+all), from dpkg-buildflags of the system that builds it: -O2, the
# stack protector, stack clash protection, fortified libc calls, a position-independent executable, a read-only relocation table and
# immediate binding. The library is built static only and linked into the programs.
export DEB_BUILD_MAINT_OPTIONS=hardening=+all
eval "$(dpkg-buildflags --export=sh)"
case " $CXXFLAGS " in *' -O2 '*) ;; *) echo "dpkg-buildflags gave no -O2: $CXXFLAGS" >&2; exit 1 ;; esac
autoreconf --force --install > "$work/autoreconf.log" 2>&1 || { tail -n 40 "$work/autoreconf.log" >&2; exit 1; }
./configure --prefix="$INSTALL_DIR" --disable-shared --enable-static --disable-desktopfiles > "$work/configure.log" 2>&1 \
  || { tail -n 40 "$work/configure.log" >&2; exit 1; }
jobs="$(nproc 2> /dev/null || echo 2)"
make -j"$jobs" > "$work/make.log" 2>&1 || { tail -n 40 "$work/make.log" >&2; exit 1; }
tools="$source_dir/tools"

# A build that lost a hardening property is a failed build: the programs must be position independent (ELF type DYN), have a read-only
# relocation table (GNU_RELRO) and bind every symbol at load time (BIND_NOW).
for program in $PROGRAMS; do
  elf_header="$(readelf -h "$tools/$program")"
  elf_dynamic="$(readelf -lW -d "$tools/$program")"
  grep -q 'Type:[[:space:]]*DYN' <<< "$elf_header" || { echo "$program is not a position independent executable" >&2; exit 1; }
  grep -q 'GNU_RELRO' <<< "$elf_dynamic" || { echo "$program has no read-only relocation segment" >&2; exit 1; }
  grep -Eq 'BIND_NOW|FLAGS_1.*NOW' <<< "$elf_dynamic" || { echo "$program does not bind its symbols at load time" >&2; exit 1; }
done

check_dir="$work/check"
mkdir "$check_dir"
# A page encoded with cjb2 from a bitmap written here: djvused must report one page of 8 x 8 pixels, and ddjvu draws it, which goes
# through its TIFF and PDF writers.
printf 'P4\n8 8\n\252\125\252\125\252\125\252\125' > "$check_dir/page.pbm"
"$tools/cjb2" "$check_dir/page.pbm" "$check_dir/page.djvu"
[ "$("$tools/djvused" -e n "$check_dir/page.djvu")" = "1" ] || { echo "djvused does not count the one page" >&2; exit 1; }
[ "$("$tools/djvused" -e size "$check_dir/page.djvu")" = "width=8 height=8" ] || { echo "djvused does not report the page size" >&2; exit 1; }
"$tools/ddjvu" -format=pdf "$check_dir/page.djvu" "$check_dir/page.pdf"
[ "$(head -c 5 "$check_dir/page.pdf")" = "%PDF-" ] || { echo "ddjvu wrote no PDF" >&2; exit 1; }

# The patches are in the build. Two bundles of a page and a chain of shared files are written here as IFF chunks
# (libdjvu/IFFByteStream.cpp) and bundled by djvm, which brings in the files a page includes:
#  - CHAIN_LEVELS files that each include the next two, which ddjvu draws within CHAIN_DRAW_SECONDS only with the search patch;
#  - THREAD_CHAIN_LEVELS files that each include the next, drawn under an address space of THREAD_CHAIN_ADDRESS_SPACE, where the thread
#    of a file deep in the chain cannot be given a stack: with the thread patch ddjvu fails within CHAIN_DRAW_SECONDS, and without it
#    it waits until it is killed.
be32() {
  printf "\\$(printf '%03o' $(($1 >> 24 & 255)))\\$(printf '%03o' $(($1 >> 16 & 255)))\\$(printf '%03o' $(($1 >> 8 & 255)))\\$(printf '%03o' $(($1 & 255)))"
}
# An INCL chunk naming a shared file, padded to an even length.
include_chunk() {
  printf 'INCL'
  be32 ${#1}
  printf '%s' "$1"
  if [ $((${#1} % 2)) -eq 1 ]; then printf '\000'; fi
}
include_chunk_bytes() {
  echo $((8 + ${#1} + ${#1} % 2))
}
# write_chain <dir> <levels> <fan-out>: <dir>/chain.djvu, a page that includes i0, and i0 to i<levels - 1>, each including the next <fan-out>.
write_chain() {
  local dir="$1" levels="$2" fan_out="$3" level next form_bytes name
  local -a names
  mkdir "$dir"
  for ((level = 0; level < levels; level++)); do
    names=()
    for ((next = level + 1; next <= level + fan_out && next < levels; next++)); do names+=("i${next}"); done
    form_bytes=4
    for name in "${names[@]}"; do form_bytes=$((form_bytes + $(include_chunk_bytes "$name"))); done
    {
      printf 'AT&TFORM'
      be32 "$form_bytes"
      printf 'DJVI'
      for name in "${names[@]}"; do include_chunk "$name"; done
    } > "$dir/i${level}"
  done
  # The page: an INFO chunk of 8 x 8 pixels at 300 dpi (libdjvu/DjVuInfo.cpp `decode`) and the include of the first shared file.
  {
    printf 'AT&TFORM'
    be32 $((4 + 18 + $(include_chunk_bytes i0)))
    printf 'DJVUINFO\000\000\000\012\000\010\000\010\030\000\054\001\026\000'
    include_chunk i0
  } > "$dir/page.djvu"
  (cd "$dir" && "$tools/djvm" -c chain.djvu page.djvu)
}
write_chain "$check_dir/fan-out" "$CHAIN_LEVELS" 2
timeout "$CHAIN_DRAW_SECONDS" "$tools/ddjvu" -format=pdf "$check_dir/fan-out/chain.djvu" "$check_dir/fan-out/chain.pdf" \
  || { echo "ddjvu did not draw a chain of $CHAIN_LEVELS shared files within ${CHAIN_DRAW_SECONDS} s: the search patch is not in the build" >&2; exit 1; }
[ "$(head -c 5 "$check_dir/fan-out/chain.pdf")" = "%PDF-" ] || { echo "ddjvu wrote no PDF of the chain" >&2; exit 1; }
write_chain "$check_dir/deep" "$THREAD_CHAIN_LEVELS" 1
status=0
timeout --signal=KILL "$CHAIN_DRAW_SECONDS" prlimit --as="$THREAD_CHAIN_ADDRESS_SPACE" -- env MALLOC_ARENA_MAX=1 \
  "$tools/ddjvu" -format=pdf "$check_dir/deep/chain.djvu" "$check_dir/deep/chain.pdf" 2> /dev/null || status=$?
[ "$status" -ne 137 ] || { echo "ddjvu was killed after ${CHAIN_DRAW_SECONDS} s on a chain whose threads cannot all start: the thread patch is not in the build" >&2; exit 1; }
[ "$status" -ne 0 ] || { echo "ddjvu drew a chain of $THREAD_CHAIN_LEVELS shared files under an address space meant to stop its threads; the check proves nothing here" >&2; exit 1; }

# The patches change no pixel: the reference manual in the source archive (57 pages of text and pictures) is drawn by the patched
# program and by the distribution's program of the same version, and pdftoppm renders both PDFs to the same pages.
if [ -n "${DJVULIBRE_REFERENCE_DDJVU:-}" ]; then
  manual="$source_dir/doc/djvulibre-book-en.djvu"
  "$tools/ddjvu" -format=pdf "$manual" "$check_dir/patched.pdf"
  "$DJVULIBRE_REFERENCE_DDJVU" -format=pdf "$manual" "$check_dir/reference.pdf"
  pdftoppm -r 50 "$check_dir/patched.pdf" "$check_dir/patched"
  pdftoppm -r 50 "$check_dir/reference.pdf" "$check_dir/reference"
  pages=0
  for rendered in "$check_dir"/patched-*.ppm; do
    cmp -s "$rendered" "${rendered/patched-/reference-}" || { echo "the patched ddjvu draws $(basename "$rendered") otherwise than $DJVULIBRE_REFERENCE_DDJVU" >&2; exit 1; }
    pages=$((pages + 1))
  done
  [ "$pages" -gt 50 ] || { echo "the reference manual rendered to $pages pages" >&2; exit 1; }
fi

install -d "$INSTALL_DIR/bin" "$INSTALL_DIR/share/doc/djvulibre/patches"
for program in $PROGRAMS; do install -m 0755 --strip "$tools/$program" "$INSTALL_DIR/bin/$program"; done
# The message catalog the programs read their error texts from (<prefix>/share/djvu/osi, libdjvu/DjVuMessage.cpp line 121), what the
# Debian package libdjvulibre-text holds; without it an error prints as "Unrecognized DjVu Message" and its name.
make install DESTDIR="$work/stage" > "$work/install.log" 2>&1 || { tail -n 40 "$work/install.log" >&2; exit 1; }
cp -R "$work/stage$INSTALL_DIR/share/djvu" "$INSTALL_DIR/share/djvu"
# The Debian-style name, so the image collects it into /licenses with the system notices.
install -m 0644 debian/copyright "$INSTALL_DIR/share/doc/djvulibre/copyright"
{
  printf 'djvulibre %s-%s, built from the Debian source package:\n' "$DJVULIBRE_VERSION" "$DJVULIBRE_DEBIAN_REVISION"
  printf '  %s/%s (sha256 %s)\n' "$DJVULIBRE_POOL" "$DJVULIBRE_ORIG" "$DJVULIBRE_ORIG_SHA256"
  printf '  %s/%s (sha256 %s), with the patches of its debian/patches/series\n' "$DJVULIBRE_POOL" "$DJVULIBRE_DEBIAN" "$DJVULIBRE_DEBIAN_SHA256"
} > "$INSTALL_DIR/share/doc/djvulibre/SOURCE"
printf 'djvulibre %s-%s (source, sha256 %s and %s)\n' "$DJVULIBRE_VERSION" "$DJVULIBRE_DEBIAN_REVISION" "$DJVULIBRE_ORIG_SHA256" "$DJVULIBRE_DEBIAN_SHA256" \
  > "$INSTALL_DIR/share/doc/djvulibre/tool-version.txt"
# The patches ship with the programs, as the GPL asks of a modified source.
for entry in "${DJVULIBRE_PATCHES[@]}"; do
  read -r patch_name patch_sha256 <<< "$entry"
  install -m 0644 "${patch_dir}/${patch_name}" "$INSTALL_DIR/share/doc/djvulibre/patches/${patch_name}"
  printf 'with the patch %s (sha256 %s), kept in /usr/share/doc/djvulibre/patches\n' "$patch_name" "$patch_sha256" >> "$INSTALL_DIR/share/doc/djvulibre/SOURCE"
  printf 'djvulibre patch %s (sha256 %s)\n' "$patch_name" "$patch_sha256" >> "$INSTALL_DIR/share/doc/djvulibre/tool-version.txt"
done

if [ "$(id -u)" -eq 0 ] && [ "$INSTALL_DIR" != "/usr/local" ]; then
  for program in $PROGRAMS; do ln -sf "$INSTALL_DIR/bin/$program" "/usr/local/bin/$program"; done
fi
# Asked for its usage the program prints its version and exits with a status other than zero.
usage="$("$INSTALL_DIR/bin/ddjvu" --help 2>&1 || true)"
grep "DjVuLibre-${DJVULIBRE_VERSION}" <<< "$usage"
