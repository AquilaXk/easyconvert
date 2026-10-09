#!/usr/bin/env bash
# Installs the packages of apt-packages.txt, from a cache of their .deb files when one was restored.
#
# Usage: install-apt-tools.sh <deb-directory> <package-list> <cache-hit: true|false>
#
# The deb directory holds exactly what `apt-get install` downloaded for this runner image: the packages the image
# did not already have, with their dependencies. The cache key names the image version and the package list, so a
# restored directory fits the image it is installed on and `dpkg -i` can unpack it without the network. A cache that
# cannot be installed (a corrupt entry, a changed image) falls back to the normal `apt-get` path, which also
# refills the directory for the step that saves the cache.
set -euo pipefail

debs="${1:?deb directory}"
list="${2:?package list}"
cache_hit="${3:-false}"

mapfile -t packages < <(grep -Ev '^[[:space:]]*(#|$)' "$list")
if [ "${#packages[@]}" -eq 0 ]; then
  echo "no packages in $list" >&2
  exit 1
fi

install_from_network() {
  sudo rm -rf "$debs"
  sudo mkdir -p "$debs"
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends -o Dir::Cache::archives="$debs" "${packages[@]}"
  # `partial` and `lock` belong to apt and are not readable by the runner user that saves the cache.
  sudo rm -rf "$debs/partial" "$debs/lock"
  sudo chown -R "$(id -u):$(id -g)" "$debs"
}

if [ "$cache_hit" = true ] && compgen -G "$debs/*.deb" > /dev/null; then
  echo "Installing $(find "$debs" -name '*.deb' | wc -l) cached packages"
  if sudo dpkg -i "$debs"/*.deb; then
    exit 0
  fi
  echo "::warning::the cached packages could not be installed; falling back to apt-get"
fi
install_from_network
