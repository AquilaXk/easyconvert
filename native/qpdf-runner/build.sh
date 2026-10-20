#!/usr/bin/env bash
# Builds qpdf-runner. It needs a C compiler and the dynamic loader library only: libqpdf is opened when the program runs, so no
# qpdf development files are needed and nothing of qpdf is linked in.
#
# Usage: build.sh <output-binary>
#   Debian and Ubuntu: apt-get install gcc libc6-dev
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
output="${1:?output binary path}"

"${CC:-cc}" -std=gnu11 -O2 -D_FORTIFY_SOURCE=2 -fstack-protector-strong -fPIE -pie -Wl,-z,relro,-z,now -Wall -Wextra \
  -o "$output" "$here/qpdf-runner.c" -ldl
