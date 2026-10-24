#!/usr/bin/env bash
# Builds the cad-convert program against the Open CASCADE development files of the system (7.6 to 7.9).
#
# Usage: build.sh <output-binary>
#   Debian and Ubuntu: apt-get install g++ libocct-data-exchange-dev libocct-ocaf-dev libocct-modeling-algorithms-dev
#                      libocct-modeling-data-dev libocct-foundation-dev
#   macOS:             brew install opencascade
# OCCT_PREFIX names the install prefix that holds include/opencascade and lib; it is found in the usual places when unset.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
output="${1:?output binary path}"

include_dir=""
lib_dir=""
if [ -n "${OCCT_PREFIX:-}" ]; then
  prefixes=("$OCCT_PREFIX")
else
  prefixes=(/usr /usr/local /opt/homebrew /opt/homebrew/opt/opencascade)
fi
for prefix in "${prefixes[@]}"; do
  if [ -f "$prefix/include/opencascade/Standard_Version.hxx" ]; then
    include_dir="$prefix/include/opencascade"
    for candidate in "$prefix/lib" "$prefix/lib/$(uname -m)-linux-gnu" "$prefix/lib/$(gcc -dumpmachine 2> /dev/null || true)"; do
      if compgen -G "$candidate/libTKernel.*" > /dev/null; then
        lib_dir="$candidate"
        break
      fi
    done
    break
  fi
done
if [ -z "$include_dir" ] || [ -z "$lib_dir" ]; then
  echo "Open CASCADE development files not found (set OCCT_PREFIX)" >&2
  exit 1
fi

# Open CASCADE 7.8 renamed the STEP and IGES toolkits (TKSTEP, TKIGES, TKXDESTEP, TKXDEIGES became TKDESTEP, TKDEIGES).
if compgen -G "$lib_dir/libTKDESTEP.*" > /dev/null; then
  exchange_libs=(TKDESTEP TKDEIGES)
else
  exchange_libs=(TKSTEP TKIGES TKXDESTEP TKXDEIGES)
fi
# The OBJ writer (RWObj_CafWriter) is in TKRWMesh up to 7.7 and in TKDEOBJ from 7.8; a library that the installed version lacks is skipped below.
libs=(TKernel TKMath TKG2d TKG3d TKGeomBase TKBRep TKGeomAlgo TKTopAlgo TKMesh TKShHealing TKXSBase TKXCAF TKLCAF TKCDF TKCAF TKRWMesh TKDEOBJ "${exchange_libs[@]}")
link=()
for lib in "${libs[@]}"; do
  if compgen -G "$lib_dir/lib$lib.*" > /dev/null; then link+=("-l$lib"); fi
done

rpath=()
if [ "$(uname -s)" = "Darwin" ]; then rpath=("-Wl,-rpath,$lib_dir"); fi
"${CXX:-c++}" -std=c++17 -O2 -D_FORTIFY_SOURCE=2 -fstack-protector-strong -Wall -Wextra \
  -isystem "$include_dir" "$here/cad-convert.cpp" -o "$output" -L"$lib_dir" "${rpath[@]}" "${link[@]}"
