#!/usr/bin/env bash
# Stands in for `curl` while build/posix.sh runs (build.sh puts it first on PATH under that name). The upstream script fetches
# every source as `curl --silent --location --retry 3 --retry-max-time 30 <url> | tar ...` (or `| patch -p1`) and checks
# nothing. This serves a URL only when sources.sha256 lists it, and only once the downloaded bytes have that SHA-256; it
# writes them to standard output, as curl would. Any other request is refused and recorded in $SHARP_LIBVIPS_REFUSALS,
# which build.sh checks after the script: a refused `| patch -p1` reads no patch and succeeds, so the exit status alone
# would not stop the build.
set -euo pipefail

real_curl="${SHARP_LIBVIPS_REAL_CURL:-/usr/bin/curl}"

refuse() {
  printf '%s\n' "$1" >> "$SHARP_LIBVIPS_REFUSALS"
  echo "fetch-pinned: $1" >&2
  exit 1
}

url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --silent | --location) shift ;;
    --retry | --retry-max-time)
      [ "$#" -ge 2 ] || refuse "$1 without a value"
      shift 2
      ;;
    https://*)
      [ -z "$url" ] || refuse "more than one URL: $url $1"
      url="$1"
      shift
      ;;
    *) refuse "unexpected argument: $1" ;;
  esac
done
[ -n "$url" ] || refuse "no URL"

expected="$(awk -v url="$url" '$1 !~ /^#/ && $2 == url { print $1 }' "$SHARP_LIBVIPS_SOURCES")"
[[ "$expected" =~ ^[0-9a-f]{64}$ ]] || refuse "not pinned once in sources.sha256: $url"

download="$(mktemp)"
trap 'rm -f "$download"' EXIT
"$real_curl" --proto '=https' --tlsv1.2 --fail --silent --show-error --location --retry 3 --retry-max-time 30 --output "$download" "$url" ||
  refuse "download failed: $url"
actual="$(sha256sum "$download" | cut -d ' ' -f 1)"
[ "$actual" = "$expected" ] || refuse "SHA-256 of $url is $actual, sources.sha256 pins $expected"
printf '%s\n' "$url" >> "$SHARP_LIBVIPS_SERVED"
cat "$download"
