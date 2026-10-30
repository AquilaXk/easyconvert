#!/usr/bin/env bash
# usage: ab-base-dependencies.sh <restored>
# Run from the checkout under test, before its node_modules get the libvips of the worker image (.github/actions/sharp-libvips).
# Gives the base checkout ab-base/ of a speed comparison (bench/ab-speed.ts) its own dependencies and its own libvips, so a
# change of either shows in the comparison:
#   - <restored> is "true": ab-base/node_modules was restored from the cache of its lock file and is kept;
#   - the same lock file and the same libvips build (docker/sharp-libvips/cache-key.sh): ab-base shares this node_modules;
#   - the same lock file and another libvips build, or none: ab-base gets a copy of this node_modules, with the npm package's library;
#   - another lock file: ab-base installs its own.
# Prints own-libvips=true when ab-base has a libvips build of its own to put into its own node_modules, for $GITHUB_OUTPUT.
set -euo pipefail
restored="$1"

head_libvips="$(bash docker/sharp-libvips/cache-key.sh .)"
base_libvips=""
if [ -f ab-base/docker/sharp-libvips/cache-key.sh ]; then base_libvips="$(bash ab-base/docker/sharp-libvips/cache-key.sh ab-base)"; fi
same_lock=false
if cmp -s package-lock.json ab-base/package-lock.json; then same_lock=true; fi

if [ "$restored" = true ]; then
  echo "the dependencies of the base come from the cache" >&2
elif [ "$same_lock" = true ] && [ "$base_libvips" = "$head_libvips" ]; then
  ln -s "$PWD/node_modules" ab-base/node_modules
elif [ "$same_lock" = true ]; then
  cp -a node_modules ab-base/node_modules
else
  (cd ab-base && npm ci --ignore-scripts --no-audit --no-fund) >&2
fi
echo "libvips of the head: $head_libvips; of the base: ${base_libvips:-none, the npm package library}" >&2

own_libvips=false
if [ -n "$base_libvips" ] && [ ! -L ab-base/node_modules ]; then own_libvips=true; fi
echo "own-libvips=$own_libvips"
