#!/usr/bin/env bash
# Builds djvulibre from the Debian 13 source of version 3.5.28 (the upstream archive and the Debian packaging, each pinned by SHA-256),
# with the Debian patches of that packaging and the patches of scripts/djvulibre-patches named in DJVULIBRE_PATCHES, and installs its
# `ddjvu` and `djvused` programs, which draw a DjVu document as a PDF and report its pages (entry 135 of docs/policy-decisions.md).
# djvulibre is GPL-2.0-or-later; the programs are used only as separate programs and are never linked into the application. The library
# is linked into them statically, so they need only the C and C++ libraries, libtiff and libjpeg at run time.
#
# Bump the version, the Debian revision, the snapshot and the two digests together: the files of the source package, whose .dsc lists the
# same SHA-256, from the snapshot of the Debian archive taken when that revision entered it (https://snapshot.debian.org/package/djvulibre/).
# The Debian patches are applied in the order of their series file, then ours, each with no fuzz, so one that no longer applies fails the
# build. Before moving the pin, read the new release's libdjvu/DjVuImage.cpp and libdjvu/DjVuFile.cpp: a patch whose change the release
# already holds is dropped from DJVULIBRE_PATCHES and its file deleted, and any other is rebased on the new file, which changes its digest
# here and in DJVULIBRE_REQUIRED_PATCHES of src/worker/djvu-render.ts. Then run tests/djvu-render.test.ts with this build.
#
# Usage: DJVULIBRE_REFERENCE_DDJVU=/usr/bin/ddjvu install-djvulibre.sh [install-dir]   (default /opt/djvulibre)
# Needs a C++ compiler, make, autoconf, automake, libtool, pkg-config, patch, curl, xz, dpkg-buildflags (dpkg-dev), the development
# packages of libjpeg and libtiff, pdftoppm, and the distribution's ddjvu of the same version (djvulibre-bin), the reference of the
# checks: on Debian, the system the worker image is built on, its package must be the revision pinned here, so that a Debian update of
# the source (a security fix) stops the build until the pin moves to it. Installs <install-dir>/bin/{ddjvu,djvused}, their message
# catalog in <install-dir>/share/djvu and, in <install-dir>/share/doc/djvulibre, the licence text (copyright), the source it was built
# from (SOURCE), the patches, which the worker takes as the stamp of this build, and tool-version.txt with the packages it was built
# with; links the programs into /usr/local/bin when it is run as root and the directory is not /usr/local.
set -euo pipefail

DJVULIBRE_VERSION="3.5.28"
DJVULIBRE_DEBIAN_REVISION="2.2"
DJVULIBRE_ORIG_SHA256="1223b7bf7c8dfe2e290882f3bfb88ba2468b30495a1bf8dfd54dc7e810987887"
DJVULIBRE_DEBIAN_SHA256="93c56218b7ea8d2a3dcec7dc982864ba9f3ece50c2e400003d938c67485d3ef6"
# The pool of deb.debian.org drops a revision once a newer one replaces it; the snapshot keeps the same files at this address.
DJVULIBRE_SNAPSHOT="https://snapshot.debian.org/archive/debian/20250721T022532Z/pool/main/d/djvulibre"
DJVULIBRE_ORIG="djvulibre_${DJVULIBRE_VERSION}.orig.tar.xz"
DJVULIBRE_DEBIAN="djvulibre_${DJVULIBRE_VERSION}-${DJVULIBRE_DEBIAN_REVISION}.debian.tar.xz"
INSTALL_DIR="${1:-/opt/djvulibre}"
REFERENCE_DDJVU="${DJVULIBRE_REFERENCE_DDJVU:?set DJVULIBRE_REFERENCE_DDJVU to the distribution ddjvu of version 3.5.28, the reference of the checks}"

# Our patches, in the order they are applied after Debian's: file name in scripts/djvulibre-patches and its SHA-256.
# include-search-visit-once.patch: libdjvu/DjVuImage.cpp and libdjvu/DjVuFile.cpp search each included file once for a page component and
# for the shape dictionary of a JB2 mask, so a shared file reached through many paths no longer costs one search per path.
# decode-thread-start-failure.patch: libdjvu/DjVuFile.cpp fails the decoding of a file whose thread does not start, instead of waiting for
# it forever.
DJVULIBRE_PATCHES=(
  "include-search-visit-once.patch 80c569b2ee1ac042c57bb52b8196dcd4057011de73f0dd99a3055c41ef16ac77"
  "decode-thread-start-failure.patch a29276f77dd11f1d8a6f77a1687614ea4edef732389e92641ce24a04536e0212"
)
patch_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/djvulibre-patches"
# The programs the worker runs; the others the build makes are not installed.
PROGRAMS="ddjvu djvused"
# The packages the programs are built with, recorded in tool-version.txt.
BUILD_PACKAGES=(g++ libjpeg-dev libtiff-dev autoconf automake libtool)
# A chain of shared files that each include the next two: drawn in 0.04 s with the patch and in about 50 s without it.
CHAIN_LEVELS=40
CHAIN_DRAW_SECONDS=10
# The JB2 mask of a page of the reference manual over chains of shared files that each include the next two: the patched program
# reports the missing shape dictionary in 0.02 s at 40 and 60 files, where the distribution's takes 8.2 s at 30 files and about 1.7
# times as long for each file more.
MASK_CHAIN_LEVELS="40 60"
# How long the distribution's program still searches a chain of CHAIN_LEVELS files when it is stopped, which shows that the chains
# exercise the search the patch changes.
REFERENCE_SEARCH_SECONDS=5
# A chain of shared files that each include the next, under an address space that holds the stacks of about 64 threads of 8 MiB.
THREAD_CHAIN_LEVELS=100
THREAD_CHAIN_ADDRESS_SPACE=$((512 * 1024 * 1024))
THREAD_STACK_KIB=8192
# The exit status of ddjvu when it cannot decode a page (tools/ddjvu.cpp `die`), and of `timeout` when it stops a command.
DDJVU_FAILED=10
TIMED_OUT=124

reference_file="$(readlink -f "$REFERENCE_DDJVU")"
reference_package="$(dpkg-query -S "$reference_file" | cut -d: -f1)"
reference_version="$(dpkg-query -W -f='${Version}' "$reference_package")"
case "$reference_version" in
  "${DJVULIBRE_VERSION}-"*) ;;
  *) echo "the reference $REFERENCE_DDJVU is $reference_package $reference_version, not version $DJVULIBRE_VERSION" >&2; exit 1 ;;
esac
if [ "$(. /etc/os-release && echo "$ID")" = debian ] && [ "$reference_version" != "${DJVULIBRE_VERSION}-${DJVULIBRE_DEBIAN_REVISION}" ]; then
  echo "Debian ships $reference_package $reference_version and the pin is ${DJVULIBRE_VERSION}-${DJVULIBRE_DEBIAN_REVISION}: move the pin to its source" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

for entry in "$DJVULIBRE_ORIG $DJVULIBRE_ORIG_SHA256" "$DJVULIBRE_DEBIAN $DJVULIBRE_DEBIAN_SHA256"; do
  read -r archive archive_sha256 <<< "$entry"
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --retry 3 -o "$work/$archive" "$DJVULIBRE_SNAPSHOT/$archive"
  echo "${archive_sha256}  $work/$archive" | sha256sum --check --strict -
done
tar -xJf "$work/$DJVULIBRE_ORIG" -C "$work"
source_dir="$work/djvulibre-${DJVULIBRE_VERSION}"
tar -xJf "$work/$DJVULIBRE_DEBIAN" -C "$source_dir"
cd "$source_dir"
while read -r debian_patch; do
  case "$debian_patch" in '' | '#'*) continue ;; esac
  patch -p1 --batch --forward --fuzz=0 --no-backup-if-mismatch --silent --input="debian/patches/${debian_patch}"
done < debian/patches/series
for entry in "${DJVULIBRE_PATCHES[@]}"; do
  read -r patch_name patch_sha256 <<< "$entry"
  echo "${patch_sha256}  ${patch_dir}/${patch_name}" | sha256sum --check --strict -
  patch -p1 --batch --forward --fuzz=0 --no-backup-if-mismatch --input="${patch_dir}/${patch_name}"
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

# The patches are in the build. Bundles of a page and a chain of shared files are written here as IFF chunks (libdjvu/IFFByteStream.cpp)
# and bundled by djvm, which brings in the files a page includes:
#  - CHAIN_LEVELS files that each include the next two, which ddjvu draws within CHAIN_DRAW_SECONDS only with the search patch;
#  - the JB2 mask of the first page of the reference manual over chains of MASK_CHAIN_LEVELS such files without its shape dictionary,
#    which ddjvu reports as missing within CHAIN_DRAW_SECONDS only with the search patch, and over a chain whose first file includes
#    the dictionary after the chain, which ddjvu draws to the pixels the distribution's program draws the page with;
#  - THREAD_CHAIN_LEVELS files that each include the next, drawn under an address space of THREAD_CHAIN_ADDRESS_SPACE, where the thread
#    of a file deep in the chain cannot be given a stack: with the thread patch ddjvu fails within CHAIN_DRAW_SECONDS, and without it
#    it waits until it is killed.
# The distribution's program is still searching the first two after REFERENCE_SEARCH_SECONDS, so they exercise what the patch changes.
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
# file_chunk <id> <file>: a chunk of <id> holding the bytes of <file>, padded to an even length.
file_chunk() {
  local bytes
  bytes="$(stat -c %s "$2")"
  printf '%s' "$1"
  be32 "$bytes"
  cat "$2"
  if [ $((bytes % 2)) -eq 1 ]; then printf '\000'; fi
}
# wrap_form <type> <chunks> <out>: <out>, a DjVu file of a FORM of <type> around the chunks in the file <chunks>.
wrap_form() {
  {
    printf 'AT&TFORM'
    be32 $((4 + $(stat -c %s "$2")))
    printf '%s' "$1"
    cat "$2"
  } > "$3"
}
# write_chain <dir> <levels> <fan-out> <info> [<mask> [<dictionary>]]: <dir>/chain.djvu, a page of the INFO chunk in the file <info> that
# includes i0, and i0 to i<levels - 1>, each including the next <fan-out>. With <mask>, the page ends with the JB2 mask chunk in that
# file; with <dictionary>, i0 also includes a file d of the shape dictionary chunk in that file, after the chain.
write_chain() {
  local dir="$1" levels="$2" fan_out="$3" info="$4" mask="${5:-}" dictionary="${6:-}" level next
  mkdir "$dir"
  for ((level = 0; level < levels; level++)); do
    {
      for ((next = level + 1; next <= level + fan_out && next < levels; next++)); do include_chunk "i${next}"; done
      if [ "$level" -eq 0 ] && [ -n "$dictionary" ]; then include_chunk d; fi
    } > "$dir/chunks"
    wrap_form DJVI "$dir/chunks" "$dir/i${level}"
  done
  if [ -n "$dictionary" ]; then
    cat "$dictionary" > "$dir/chunks"
    wrap_form DJVI "$dir/chunks" "$dir/d"
  fi
  {
    cat "$info"
    include_chunk i0
    if [ -n "$mask" ]; then cat "$mask"; fi
  } > "$dir/chunks"
  wrap_form DJVU "$dir/chunks" "$dir/page.djvu"
  (cd "$dir" && "$tools/djvm" -c chain.djvu page.djvu)
}
# status_of <command...>: the exit status of the command, which may fail without stopping the script.
status_of() {
  local status=0
  "$@" > /dev/null 2>&1 || status=$?
  echo "$status"
}
# same_pixels <a.pdf> <b.pdf> <pages>: whether pdftoppm renders the two PDFs to the same pixels, and to <pages> pages.
same_pixels() {
  local rendered pages=0
  mkdir "$1.pages" "$2.pages"
  pdftoppm -r 50 "$1" "$1.pages/page"
  pdftoppm -r 50 "$2" "$2.pages/page"
  for rendered in "$1.pages"/*.ppm; do
    cmp -s "$rendered" "$2.pages/$(basename "$rendered")" || { echo "$(basename "$rendered") differs" >&2; return 1; }
    pages=$((pages + 1))
  done
  [ "$pages" -eq "$3" ] || { echo "$1 rendered to $pages pages, not $3" >&2; return 1; }
}

# The INFO chunk of a page of 8 x 8 pixels at 300 dpi (libdjvu/DjVuInfo.cpp `decode`).
printf 'INFO\000\000\000\012\000\010\000\010\030\000\054\001\026\000' > "$check_dir/info"
write_chain "$check_dir/fan-out" "$CHAIN_LEVELS" 2 "$check_dir/info"
status="$(status_of timeout "$CHAIN_DRAW_SECONDS" "$tools/ddjvu" -format=pdf "$check_dir/fan-out/chain.djvu" "$check_dir/fan-out/chain.pdf")"
[ "$status" -eq 0 ] || { echo "ddjvu ended with status $status on a chain of $CHAIN_LEVELS shared files: the search patch is not in the build" >&2; exit 1; }
[ "$(head -c 5 "$check_dir/fan-out/chain.pdf")" = "%PDF-" ] || { echo "ddjvu wrote no PDF of the chain" >&2; exit 1; }
status="$(status_of timeout "$REFERENCE_SEARCH_SECONDS" "$REFERENCE_DDJVU" -format=pdf "$check_dir/fan-out/chain.djvu" "$check_dir/fan-out/reference.pdf")"
[ "$status" -eq "$TIMED_OUT" ] || { echo "$REFERENCE_DDJVU ended with status $status within ${REFERENCE_SEARCH_SECONDS} s on the chain of $CHAIN_LEVELS files; the check proves nothing here" >&2; exit 1; }

# The mask and the dictionary of the first page of the reference manual (57 pages of text and pictures whose masks share dictionaries).
manual="$source_dir/doc/djvulibre-book-en.djvu"
mkdir "$check_dir/manual" "$check_dir/mask"
"$tools/djvmcvt" -i "$manual" "$check_dir/manual" index.djvu
"$tools/djvuextract" "$check_dir/manual/p0001.djvu" INFO="$check_dir/mask/info.data" Sjbz="$check_dir/mask/sjbz.data" > /dev/null 2>&1
"$tools/djvuextract" "$check_dir/manual/dict0020.iff" Djbz="$check_dir/mask/djbz.data" > /dev/null 2>&1
file_chunk INFO "$check_dir/mask/info.data" > "$check_dir/mask/info"
file_chunk Sjbz "$check_dir/mask/sjbz.data" > "$check_dir/mask/sjbz"
file_chunk Djbz "$check_dir/mask/djbz.data" > "$check_dir/mask/djbz"
for levels in $MASK_CHAIN_LEVELS; do
  write_chain "$check_dir/mask$levels" "$levels" 2 "$check_dir/mask/info" "$check_dir/mask/sjbz"
  status="$(status_of timeout "$CHAIN_DRAW_SECONDS" "$tools/ddjvu" -format=pdf "$check_dir/mask$levels/chain.djvu" "$check_dir/mask$levels/chain.pdf")"
  [ "$status" -eq "$DDJVU_FAILED" ] || { echo "ddjvu ended with status $status on a mask over $levels shared files without its dictionary: the search patch is not in the build" >&2; exit 1; }
done
first_levels="${MASK_CHAIN_LEVELS%% *}"
status="$(status_of timeout "$REFERENCE_SEARCH_SECONDS" "$REFERENCE_DDJVU" -format=pdf "$check_dir/mask$first_levels/chain.djvu" "$check_dir/mask$first_levels/reference.pdf")"
[ "$status" -eq "$TIMED_OUT" ] || { echo "$REFERENCE_DDJVU ended with status $status within ${REFERENCE_SEARCH_SECONDS} s on the mask over $first_levels files; the check proves nothing here" >&2; exit 1; }
last_levels="${MASK_CHAIN_LEVELS##* }"
write_chain "$check_dir/dictionary" "$last_levels" 2 "$check_dir/mask/info" "$check_dir/mask/sjbz" "$check_dir/mask/djbz"
status="$(status_of timeout "$CHAIN_DRAW_SECONDS" "$tools/ddjvu" -format=pdf "$check_dir/dictionary/chain.djvu" "$check_dir/dictionary/chain.pdf")"
[ "$status" -eq 0 ] || { echo "ddjvu ended with status $status on a mask over $last_levels shared files whose first includes its dictionary" >&2; exit 1; }
"$REFERENCE_DDJVU" -format=pdf "$check_dir/manual/p0001.djvu" "$check_dir/dictionary/reference.pdf"
same_pixels "$check_dir/dictionary/chain.pdf" "$check_dir/dictionary/reference.pdf" 1 \
  || { echo "the mask found its dictionary through the chain and was drawn otherwise than $REFERENCE_DDJVU draws the page" >&2; exit 1; }

write_chain "$check_dir/deep" "$THREAD_CHAIN_LEVELS" 1 "$check_dir/info"
status="$(ulimit -s "$THREAD_STACK_KIB" && status_of timeout --signal=KILL "$CHAIN_DRAW_SECONDS" prlimit --as="$THREAD_CHAIN_ADDRESS_SPACE" -- \
  env MALLOC_ARENA_MAX=1 "$tools/ddjvu" -format=pdf "$check_dir/deep/chain.djvu" "$check_dir/deep/chain.pdf")"
[ "$status" -eq "$DDJVU_FAILED" ] || { echo "ddjvu ended with status $status on a chain whose threads cannot all start: the thread patch is not in the build" >&2; exit 1; }

# The patches change no pixel: the reference manual is drawn by the patched program and by the distribution's program of the same version,
# and pdftoppm renders both PDFs to the same pages.
"$tools/ddjvu" -format=pdf "$manual" "$check_dir/patched.pdf"
"$REFERENCE_DDJVU" -format=pdf "$manual" "$check_dir/reference.pdf"
same_pixels "$check_dir/patched.pdf" "$check_dir/reference.pdf" "$("$tools/djvused" -e n "$manual")" \
  || { echo "the patched ddjvu draws the reference manual otherwise than $REFERENCE_DDJVU" >&2; exit 1; }

doc_dir="$INSTALL_DIR/share/doc/djvulibre"
# A build into a directory that holds an earlier one replaces the patches and the catalog of that build.
rm -rf "$doc_dir/patches" "$INSTALL_DIR/share/djvu"
install -d "$INSTALL_DIR/bin" "$doc_dir/patches" "$INSTALL_DIR/share/djvu"
for program in $PROGRAMS; do install -m 0755 --strip "$tools/$program" "$INSTALL_DIR/bin/$program"; done
# The message catalog the programs read their error texts from (<prefix>/share/djvu/osi, libdjvu/DjVuMessage.cpp line 121), what the
# Debian package libdjvulibre-text holds; without it an error prints as "Unrecognized DjVu Message" and its name.
make install DESTDIR="$work/stage" > "$work/install.log" 2>&1 || { tail -n 40 "$work/install.log" >&2; exit 1; }
cp -a "$work/stage$INSTALL_DIR/share/djvu/." "$INSTALL_DIR/share/djvu/"
# The Debian-style name, so the image collects it into /licenses with the system notices.
install -m 0644 debian/copyright "$doc_dir/copyright"
{
  printf 'djvulibre %s-%s, built from the Debian source package:\n' "$DJVULIBRE_VERSION" "$DJVULIBRE_DEBIAN_REVISION"
  printf '  %s/%s (sha256 %s)\n' "$DJVULIBRE_SNAPSHOT" "$DJVULIBRE_ORIG" "$DJVULIBRE_ORIG_SHA256"
  printf '  %s/%s (sha256 %s), with the patches of its debian/patches/series\n' "$DJVULIBRE_SNAPSHOT" "$DJVULIBRE_DEBIAN" "$DJVULIBRE_DEBIAN_SHA256"
} > "$doc_dir/SOURCE"
{
  printf 'djvulibre %s-%s (source, sha256 %s and %s)\n' "$DJVULIBRE_VERSION" "$DJVULIBRE_DEBIAN_REVISION" "$DJVULIBRE_ORIG_SHA256" "$DJVULIBRE_DEBIAN_SHA256"
  dpkg-query -W -f='djvulibre built with ${binary:Package} ${Version}\n' "${BUILD_PACKAGES[@]}"
  printf 'djvulibre checked against %s %s\n' "$reference_package" "$reference_version"
} > "$doc_dir/tool-version.txt"
# The patches ship with the programs, as the GPL asks of a modified source.
for entry in "${DJVULIBRE_PATCHES[@]}"; do
  read -r patch_name patch_sha256 <<< "$entry"
  install -m 0644 "${patch_dir}/${patch_name}" "$doc_dir/patches/${patch_name}"
  printf 'with the patch %s (sha256 %s), kept in /usr/share/doc/djvulibre/patches\n' "$patch_name" "$patch_sha256" >> "$doc_dir/SOURCE"
  printf 'djvulibre patch %s (sha256 %s)\n' "$patch_name" "$patch_sha256" >> "$doc_dir/tool-version.txt"
done

if [ "$(id -u)" -eq 0 ] && [ "$INSTALL_DIR" != "/usr/local" ]; then
  for program in $PROGRAMS; do ln -sf "$INSTALL_DIR/bin/$program" "/usr/local/bin/$program"; done
fi
# Asked for its usage the program prints its version and exits with a status other than zero.
usage="$("$INSTALL_DIR/bin/ddjvu" --help 2>&1 || true)"
grep "DjVuLibre-${DJVULIBRE_VERSION}" <<< "$usage"
