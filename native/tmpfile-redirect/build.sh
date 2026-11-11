#!/usr/bin/env bash
# Builds libeasyconvert-tmpfile.so (tmpfile-redirect.c). It needs a C compiler only.
#
# Usage: build.sh <output-library>
#   Debian and Ubuntu: apt-get install gcc libc6-dev
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
output="${1:?output library path}"

"${CC:-cc}" -std=gnu11 -O2 -D_FORTIFY_SOURCE=2 -fstack-protector-strong -fPIC -shared -Wl,-z,relro,-z,now -Wall -Wextra \
  -o "$output" "$here/tmpfile-redirect.c"
