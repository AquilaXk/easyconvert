#!/usr/bin/env bash
# usage: use-libvips.sh <checkout root> <build output>
# Puts the libvips-cpp.so of a build of the sharplibvips stage (its exported files, laid out as node_modules/...) over the one
# the npm package installed in <checkout root>, as the worker image does, then runs check-sharp.sh there. Running it again
# with the same build leaves the same file.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/env.sh"
root="$(cd "$1" && pwd)"
build="$(cd "$2" && pwd)"

library="node_modules/@img/sharp-libvips-linux-${NPM_ARCH}/lib/libvips-cpp.so.${VIPS_VERSION}"
cp "$build/$library" "$root/$library.next"
mv "$root/$library.next" "$root/$library"
cmp "$build/$library" "$root/$library"
bash "$here/check-sharp.sh" "$root"
