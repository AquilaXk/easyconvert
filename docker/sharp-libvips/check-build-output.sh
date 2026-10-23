#!/usr/bin/env bash
# usage: check-build-output.sh <build output>
# Fails unless <build output>, the files of a build of the sharplibvips stage (build.sh), holds exactly libvips-cpp.so.<VIPS_VERSION>
# and its .sha256 file, both regular files and neither a symlink, and the digest in the second is the one of the first. Prints
# that digest. The directory comes from the Actions cache in CI and from the build contexts of the worker image, so nothing
# else in it, such as a replaced addon or a link out of the tree, is copied into node_modules.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/env.sh"
dir="${1%/}"
name="libvips-cpp.so.${VIPS_VERSION}"

fail() {
  echo "check-build-output: $1" >&2
  exit 1
}

[ -d "$dir" ] || fail "$dir is not a directory"
found="$(find "$dir" -mindepth 1 | LC_ALL=C sort)"
[ "$found" = "$(printf '%s\n%s' "$dir/$name" "$dir/$name.sha256")" ] ||
  fail "$dir must hold $name and $name.sha256 and nothing else, it holds: $(tr '\n' ' ' <<< "$found")"
for file in "$dir/$name" "$dir/$name.sha256"; do
  { [ -f "$file" ] && [ ! -L "$file" ]; } || fail "$file is not a regular file"
done
(cd "$dir" && sha256sum --check --strict --quiet "$name.sha256") >&2 || fail "the digest file does not describe $name"
read -r digest _ < "$dir/$name.sha256"
[[ "$digest" =~ ^[0-9a-f]{64}$ ]] || fail "no SHA-256 in $name.sha256"
echo "$digest"
