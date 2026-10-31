#!/usr/bin/env bash
# Builds the pinned FFmpeg release and installs its `ffmpeg` and `ffprobe` programs, the engine of every audio and video conversion.
# FFmpeg is built with --enable-gpl (libx264 and libx265 are GPL-2.0-or-later), so the programs are GPL-2.0-or-later; they are used only
# as separate programs and are never linked into the application. The archive is verified against a fixed SHA-256 before anything in
# it runs (the release is also signed: ffmpeg-9.0.2.tar.xz.asc by key FCF986EA15E6E293A5644F10B4322F04D67658D8), and then gets the
# patches of scripts/ffmpeg-patches named in FFMPEG_PATCHES, each pinned by SHA-256 and applied with no fuzz.
# Nothing is nonfree: no --enable-nonfree, no libfdk-aac. The codec libraries are the development packages of the Debian release
# the image is based on, so the runtime stage installs the same packages' runtime libraries (see FFMPEG_RUNTIME_PACKAGES in
# Dockerfile.worker).
#
# Bump FFMPEG_VERSION and FFMPEG_SHA256 together (the digest of `ffmpeg-<version>.tar.xz` on https://ffmpeg.org/releases/). The
# patches are applied to the new archive with the same command, and one that no longer applies fails the build. Before moving the
# pin, read the new release's version of each patched file: a patch whose change the release already holds is dropped from
# FFMPEG_PATCHES and its file deleted, and any other is rebased on the new file, which changes its digest here. Then run the media
# tests with FFMPEG_PATH and FFPROBE_PATH set to the new build.
#
# Usage: install-ffmpeg.sh [install-dir]   (default /opt/ffmpeg)
# Needs a C compiler, make, patch, nasm (x86), pkg-config, curl, xz and the development packages named in Dockerfile.worker. Installs
# <install-dir>/bin/{ffmpeg,ffprobe}, <install-dir>/lib (the libav* libraries; the programs find them through their RUNPATH) and the licence
# text at <install-dir>/share/doc/ffmpeg/copyright, and links the programs into /usr/local/bin when it is run as root and the directory is
# not /usr/local.
set -euo pipefail

FFMPEG_VERSION="9.0.2"
FFMPEG_SHA256="8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e"
FFMPEG_URL="https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"
INSTALL_DIR="${1:-/opt/ffmpeg}"

# The patches, in the order they are applied: file name in scripts/ffmpeg-patches and its SHA-256.
# libvorbis-whole-frames.patch: libavcodec/libvorbisenc.c takes frames of any size, so that ffmpeg 9 no longer hands the encoder
# thread a frame of 64 samples at a time; the Vorbis stream it writes is the one it wrote before (entry 131 of docs/policy-decisions.md).
FFMPEG_PATCHES=(
  "libvorbis-whole-frames.patch 1e3f0617c7c7778bf308aefea46479a6c7ae15ad2bf440ff9c084d422e97052d"
)
patch_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ffmpeg-patches"

# What the conversions name, checked after the build: a configure that silently left one out would otherwise ship a worker that
# answers 503 for that target.
REQUIRED_ENCODERS="libx264 libx265 libvpx-vp9 libsvtav1 libopus libvorbis libmp3lame libtheora libwebp_anim aac flac wmav2 ac3 mpeg4 prores_ks h264_vaapi hevc_vaapi h264_nvenc hevc_nvenc"
REQUIRED_DECODERS="libdav1d aac hevc h264 vp9 av1 opus vorbis flac"
REQUIRED_FILTERS="zscale subtitles bwdif scale fps aresample loudnorm"
REQUIRED_BUILD_FLAGS="--enable-libsoxr --enable-libzimg --enable-libass"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --retry 3 -o "$work/ffmpeg.tar.xz" "$FFMPEG_URL"
echo "${FFMPEG_SHA256}  $work/ffmpeg.tar.xz" | sha256sum --check --strict -
tar -xJf "$work/ffmpeg.tar.xz" -C "$work"
source_dir="$work/ffmpeg-${FFMPEG_VERSION}"
cd "$source_dir"
for entry in "${FFMPEG_PATCHES[@]}"; do
  read -r patch_name patch_sha256 <<< "$entry"
  echo "${patch_sha256}  ${patch_dir}/${patch_name}" | sha256sum --check --strict -
  patch -p1 --forward --fuzz=0 --no-backup-if-mismatch --input="${patch_dir}/${patch_name}"
done

# --disable-autodetect: only the libraries named here are linked, so a missing development package fails the configure instead of
# dropping a feature. Hardening is the toolchain upstream ships for it (`--toolchain=hardened` in configure: position-independent
# executables, a read-only relocation table, immediate binding, the stack protector and fortified libc calls). Optimisation is
# the upstream default, -O3.
# Left out on purpose: the network protocols and TLS (the worker reads files and runs FFmpeg without a network), the capture and
# playback devices (only the lavfi input is used, for generated test sources and the hardware probe), ffplay, the documentation, and
# every codec library no conversion names (libaom, libopenjpeg, libgsm, libspeex, libshine, libtwolame, libxvid, libbluray, libcdio...).
# H.264 and HEVC encode in software through libx264 and libx265; VAAPI and NVENC are the hardware paths of the argument builders.
./configure \
  --prefix="$INSTALL_DIR" \
  --toolchain=hardened \
  --enable-gpl \
  --disable-autodetect \
  --disable-doc \
  --disable-ffplay \
  --disable-network \
  --disable-outdevs \
  --disable-indevs \
  --enable-indev=lavfi \
  --enable-shared \
  --disable-static \
  --enable-rpath \
  --enable-zlib \
  --enable-bzlib \
  --enable-lzma \
  --enable-iconv \
  --enable-libx264 \
  --enable-libx265 \
  --enable-libvpx \
  --enable-libsvtav1 \
  --enable-libdav1d \
  --enable-libopus \
  --enable-libmp3lame \
  --enable-libvorbis \
  --enable-libtheora \
  --enable-libwebp \
  --enable-libsoxr \
  --enable-libzimg \
  --enable-libass \
  --enable-vaapi \
  --enable-libdrm \
  --enable-ffnvcodec \
  --enable-nvenc \
  > "$work/configure.log" 2>&1 || { tail -n 40 "$work/configure.log" >&2; exit 1; }
jobs="$(nproc 2> /dev/null || echo 2)"
make -j"$jobs" > "$work/make.log" 2>&1 || { tail -n 40 "$work/make.log" >&2; exit 1; }
# Only the programs and the shared libraries they load: the headers, the pkg-config files, the presets and the examples are for building against FFmpeg.
make install-progs install-libs > "$work/install.log" 2>&1 || { tail -n 40 "$work/install.log" >&2; exit 1; }
rm -rf "$INSTALL_DIR/lib/pkgconfig"

# A build that lost a hardening property is a failed build: each program must be position independent (ELF type DYN), and every
# ELF, the programs and the libav* libraries that hold the demuxers and decoders alike, must have a read-only relocation table
# (GNU_RELRO), bind every symbol at load time (BIND_NOW) and find the libraries through a RUNPATH equal to the install lib directory
# (no RPATH, which the loader would search before LD_LIBRARY_PATH).
for program in ffmpeg ffprobe; do
  grep -q 'Type:[[:space:]]*DYN' <<< "$(readelf -h "$INSTALL_DIR/bin/$program")" || { echo "$program is not a position independent executable" >&2; exit 1; }
done
for elf in "$INSTALL_DIR"/bin/ffmpeg "$INSTALL_DIR"/bin/ffprobe "$INSTALL_DIR"/lib/*.so.*; do
  elf_dynamic="$(readelf -lW -d "$elf")"
  grep -q 'GNU_RELRO' <<< "$elf_dynamic" || { echo "$elf has no read-only relocation segment" >&2; exit 1; }
  grep -Eq 'BIND_NOW|FLAGS_1.*NOW' <<< "$elf_dynamic" || { echo "$elf does not bind its symbols at load time" >&2; exit 1; }
  grep -q '(RPATH)' <<< "$elf_dynamic" && { echo "$elf has an RPATH" >&2; exit 1; }
  grep -Fq "Library runpath: [$INSTALL_DIR/lib]" <<< "$elf_dynamic" || { echo "$elf has no RUNPATH equal to $INSTALL_DIR/lib" >&2; exit 1; }
done

ffmpeg_bin="$INSTALL_DIR/bin/ffmpeg"
buildconf="$("$ffmpeg_bin" -hide_banner -buildconf)"
for flag in $REQUIRED_BUILD_FLAGS; do
  grep -q -- "$flag" <<< "$buildconf" || { echo "the build lacks $flag" >&2; exit 1; }
done
if grep -q -- '--enable-nonfree' <<< "$buildconf"; then echo "the build is nonfree" >&2; exit 1; fi
encoders="$("$ffmpeg_bin" -hide_banner -encoders)"
for name in $REQUIRED_ENCODERS; do
  awk -v name="$name" '$2 == name { found = 1 } END { exit !found }' <<< "$encoders" || { echo "the build has no $name encoder" >&2; exit 1; }
done
decoders="$("$ffmpeg_bin" -hide_banner -decoders)"
for name in $REQUIRED_DECODERS; do
  awk -v name="$name" '$2 == name { found = 1 } END { exit !found }' <<< "$decoders" || { echo "the build has no $name decoder" >&2; exit 1; }
done
filters="$("$ffmpeg_bin" -hide_banner -filters)"
for name in $REQUIRED_FILTERS; do
  awk -v name="$name" '$2 == name { found = 1 } END { exit !found }' <<< "$filters" || { echo "the build has no $name filter" >&2; exit 1; }
done

# The patch of the Vorbis encoder is in the build, and the stream it writes does not depend on the size of the frames it is sent
# (before the patch the encoder asked for frames of 64 samples, and the same stream came out of every size ffmpeg was told to use).
grep -Eq 'General capabilities:.*\bvariable\b' <<< "$("$ffmpeg_bin" -hide_banner -h encoder=libvorbis)" || { echo "libvorbis does not take frames of any size: the libvorbis patch is not in the build" >&2; exit 1; }
vorbis_stream() {
  "$ffmpeg_bin" -hide_banner -v error -f lavfi -i "anoisesrc=d=3:r=44100:c=white:a=0.5:seed=1" -af "asetnsamples=n=$1:p=0" -c:a libvorbis -q:a 5 -fflags +bitexact -f ogg - | sha256sum
}
[ "$(vorbis_stream 64)" = "$(vorbis_stream 100)" ] && [ "$(vorbis_stream 64)" = "$(vorbis_stream 100000)" ] || { echo "the libvorbis encoder writes another stream for another frame size" >&2; exit 1; }

install -d "$INSTALL_DIR/share/doc/ffmpeg"
# The Debian-style name, so the image collects it into /licenses with the system notices.
install -m 0644 COPYING.GPLv2 "$INSTALL_DIR/share/doc/ffmpeg/copyright"
install -m 0644 LICENSE.md "$INSTALL_DIR/share/doc/ffmpeg/LICENSE.md"
printf 'FFmpeg %s, built from %s\nSHA-256 %s\n' "$FFMPEG_VERSION" "$FFMPEG_URL" "$FFMPEG_SHA256" > "$INSTALL_DIR/share/doc/ffmpeg/SOURCE"
printf 'ffmpeg %s (source, sha256 %s)\n' "$FFMPEG_VERSION" "$FFMPEG_SHA256" > "$INSTALL_DIR/share/doc/ffmpeg/tool-version.txt"
# The patches ship with the programs, as the GPL asks of a modified source.
install -d "$INSTALL_DIR/share/doc/ffmpeg/patches"
for entry in "${FFMPEG_PATCHES[@]}"; do
  read -r patch_name patch_sha256 <<< "$entry"
  install -m 0644 "${patch_dir}/${patch_name}" "$INSTALL_DIR/share/doc/ffmpeg/patches/${patch_name}"
  printf 'with the patch %s (sha256 %s), kept in /usr/share/doc/ffmpeg/patches\n' "$patch_name" "$patch_sha256" >> "$INSTALL_DIR/share/doc/ffmpeg/SOURCE"
  printf 'ffmpeg patch %s (sha256 %s)\n' "$patch_name" "$patch_sha256" >> "$INSTALL_DIR/share/doc/ffmpeg/tool-version.txt"
done
printf '%s\n' "$buildconf" > "$INSTALL_DIR/share/doc/ffmpeg/buildconf.txt"

if [ "$(id -u)" -eq 0 ] && [ "$INSTALL_DIR" != "/usr/local" ]; then
  ln -sf "$INSTALL_DIR/bin/ffmpeg" /usr/local/bin/ffmpeg
  ln -sf "$INSTALL_DIR/bin/ffprobe" /usr/local/bin/ffprobe
fi
"$ffmpeg_bin" -version | head -n 1
"$INSTALL_DIR/bin/ffprobe" -version | head -n 1
