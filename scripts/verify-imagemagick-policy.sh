#!/bin/sh
# Fails unless ImageMagick, started with MAGICK_CONFIGURE_PATH naming the repository policy directory, reads no policy file but the
# repository's (and the distribution's file the worker image overwrites with it), and no file allows anything the repository's does not.
# Usage: verify-imagemagick-policy.sh <magick executable> <directory of the repository policy.xml>
set -eu
magick=$1
dir=$2
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

MAGICK_CONFIGURE_PATH="$dir" "$magick" -list policy > "$work/listing"

# 1. Paths: ours, the distribution's policy file of version 6 or 7, or the built-in (empty) policy.
unexpected=$(grep '^Path:' "$work/listing" | grep -v -F -x -e "Path: $dir/policy.xml" -e 'Path: [built-in]' | grep -v -E -x 'Path: /etc/ImageMagick-[67]/policy\.xml' || true)
if [ -n "$unexpected" ]; then
  echo "ImageMagick reads a policy file that is not ours: $unexpected" >&2
  exit 1
fi

# 2. Rules that allow something (rights other than None), by the file they come from.
awk -v ours="Path: $dir/policy.xml" '
  /^Path:/ { section = ($0 == ours) ? "ours" : "other"; seen_ours = seen_ours || section == "ours" }
  /^ *Policy:/ { domain = $2; rights = "None" }
  /^ *rights:/ { rights = $0; sub(/^ *rights: */, "", rights); sub(/ +$/, "", rights) }
  /^ *pattern:/ { pattern = $0; sub(/^ *pattern: */, "", pattern); if (rights != "None") print section "\t" domain " " rights " " pattern; rights = "None" }
  END { if (!seen_ours) print "missing\tour policy is not listed" }
' "$work/listing" > "$work/allows"

if grep -q '^missing' "$work/allows"; then
  echo "ImageMagick does not list the repository policy $dir/policy.xml" >&2
  exit 1
fi
grep '^ours' "$work/allows" | cut -f2- | sort -u > "$work/ours"
grep '^other' "$work/allows" | cut -f2- | sort -u > "$work/other" || true
extra=$(comm -13 "$work/ours" "$work/other")
if [ -n "$extra" ]; then
  echo "A policy file allows what the repository policy does not: $extra" >&2
  exit 1
fi
echo "ImageMagick policy verified: $(wc -l < "$work/ours" | tr -d ' ') allow rules, all ours"
