#!/usr/bin/env bash
# usage: use-libvips.sh <checkout root> <build output>
# Puts the libvips-cpp.so of a build of the sharplibvips stage (check-build-output.sh says what the directory must hold) over
# the one the npm package installed in <checkout root>, as the worker image does, then runs check-sharp.sh there with the
# digest of the build. Running it again with the same build leaves the same file.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/env.sh"
root="$(cd "$1" && pwd)"
build="$(cd "$2" && pwd)"

digest="$(bash "$here/check-build-output.sh" "$build")"
name="libvips-cpp.so.${VIPS_VERSION}"
library="node_modules/@img/sharp-libvips-linux-${NPM_ARCH}/lib/$name"
cp "$build/$name" "$root/$library.next"
mv "$root/$library.next" "$root/$library"
cmp "$build/$name" "$root/$library"
bash "$here/check-sharp.sh" "$root" "$digest"
