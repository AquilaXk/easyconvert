#!/usr/bin/env bash
# Stands in for `git` while build/posix.sh runs (build.sh puts it first on PATH under that name). The script never calls git,
# but the sources it builds do: libxml2's meson.build requires the program, and it and aom ask it for a version (`git describe`,
# `git --git-dir=<dir>/.git describe`, and CMake's `git --version`), which has no repository to read in an unpacked archive and
# falls back to the version in the sources. Those local queries go to the real git. Anything else, such as the clone that a
# Meson wrap-git file or a CMake fetch step runs with no digest to check, is refused and recorded in $SHARP_LIBVIPS_REFUSALS,
# which build.sh checks after the script, so a tool that swallows the failure still stops the build. env.sh also sets Meson's
# --wrap-mode=nodownload, which keeps Meson from reaching for git at all; this is the second layer.
set -euo pipefail

rest=("$@")
while [[ "${rest[0]:-}" == --git-dir=* ]]; do rest=("${rest[@]:1}"); done
case "${rest[0]:-}" in
  --version | describe) exec "${SHARP_LIBVIPS_REAL_GIT:-/usr/bin/git}" "$@" ;;
esac

printf 'git %s\n' "$*" >> "$SHARP_LIBVIPS_REFUSALS"
echo "git-local-only: git $*" >&2
exit 1
