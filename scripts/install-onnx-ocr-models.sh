#!/usr/bin/env bash
# Installs the models of the ONNX Korean OCR engine (src/lib/conversions/ocr-onnx.ts): the PP-OCRv5 mobile text detector, the PP-OCRv5
# Korean mobile line recognizer and the recognizer's character list. The weights are PaddleOCR's (Apache-2.0), converted to ONNX and
# published by the RapidOCR project (Apache-2.0) at a tagged release; they are data read by onnxruntime, never code that runs. Each file is
# verified against a fixed SHA-256 before it is copied, and the three are written under the names the engine reads (det.onnx, rec.onnx,
# dict.txt) beside a NOTICE that says where they come from and under which licence.
#
# The licence texts that travel with the models and the runtime are installed beside them under <install-dir>/licenses, each checked against a
# fixed SHA-256 and taken from a tagged commit, not a branch: the MIT text of onnxruntime and its ThirdPartyNotices.txt (the notices of the libraries
# its native library is built from: protobuf, abseil, Eigen, onnx, re2, flatbuffers, cpuinfo and others; the npm package ships neither file), and the
# Apache-2.0 texts of PaddleOCR (the weights) and RapidOCR (the conversion). Neither of those two projects has a NOTICE file; the NOTICE written here
# says where the models come from. Dockerfile.worker copies them to /licenses.
#
# Bump ONNX_OCR_RELEASE and the three digests together, and run tests/ocr-onnx-real.test.ts with the new files before moving the pin. Bump
# ORT_COMMIT (the commit of the tag of the onnxruntime-node version in package.json) and its two digests with that package.
#
# Usage: install-onnx-ocr-models.sh [install-dir]   (default /opt/ocr-onnx; needs curl and sha256sum)
# With ONNX_OCR_DOWNLOADS set (CI), a download kept there from an earlier run is used when its digest still matches, and a fresh one is
# kept there for the next run; the digest is checked on every use either way. The files are about 18 MB in all.
set -euo pipefail

ONNX_OCR_RELEASE="v3.10.0"
ONNX_OCR_BASE="https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/${ONNX_OCR_RELEASE}"
DET_PATH="onnx/PP-OCRv5/det/ch_PP-OCRv5_det_mobile.onnx"
DET_SHA256="4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae"
REC_PATH="onnx/PP-OCRv5/rec/korean_PP-OCRv5_rec_mobile.onnx"
REC_SHA256="cd6e2ea50f6943ca7271eb8c56a877a5a90720b7047fe9c41a2e541a25773c9b"
DICT_PATH="paddle/PP-OCRv5/rec/korean_PP-OCRv5_rec_mobile/ppocrv5_korean_dict.txt"
DICT_SHA256="a88071c68c01707489baa79ebe0405b7beb5cca229f4fc94cc3ef992328802d7"
ORT_VERSION="1.31.1"
ORT_COMMIT="6af1a932e2286d5c58166085d24c68783033edee"
ORT_LICENSE_SHA256="2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c"
ORT_NOTICES_SHA256="143764b952fdb1a7c69ce653bfba74a7744d6a8a573bfb73e235fba356c83de3"
PADDLEOCR_TAG="v3.7.0"
PADDLEOCR_COMMIT="b03f46425e8ff4442b268ce449e3eef758146cd4"
PADDLEOCR_LICENSE_SHA256="3840c5c0c61c294264d2dd77b8777be6ddd90121ef4e0e64abcd22edea581d6e"
RAPIDOCR_COMMIT="bd941dae09da793e76c6ba15c7aaf40f8424232a"
RAPIDOCR_LICENSE_SHA256="3e0af25fdd06aa9586ae97adb00ea927ebe5a3805ac77d2d3a81ce5f55693333"
# The largest file is 13.5 MB (the ThirdPartyNotices.txt is 0.34 MB). curl refuses a download announced as larger, and the read stops one byte past the bound.
MAX_DOWNLOAD_BYTES=$((32 * 1024 * 1024))
INSTALL_DIR="${1:-/opt/ocr-onnx}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fetch() {
  local status=0
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --max-filesize "$MAX_DOWNLOAD_BYTES" --fail --silent --show-error --location --retry 6 --retry-delay 10 -o - "$2" \
    | head -c "$((MAX_DOWNLOAD_BYTES + 1))" > "$1" || status=$?
  if [ "$(wc -c < "$1")" -gt "$MAX_DOWNLOAD_BYTES" ]; then
    echo "install-onnx-ocr-models.sh: $2 is larger than $MAX_DOWNLOAD_BYTES bytes" >&2
    exit 1
  fi
  if [ "$status" -ne 0 ]; then
    echo "install-onnx-ocr-models.sh: the download of $2 failed (status $status)" >&2
    exit 1
  fi
}

# Downloads one file (or takes it from the download cache), checks its digest and copies it to the install directory under `target`.
# The cache keeps it under the digest's first sixteen characters and its own name, so two files called LICENSE do not meet there.
install_from() {
  local url="$1" sum="$2" target="$3" cached
  cached="${sum:0:16}-$(basename "$url")"
  if [ -n "${ONNX_OCR_DOWNLOADS:-}" ] && echo "${sum}  ${ONNX_OCR_DOWNLOADS}/${cached}" | sha256sum --check --strict --status - 2>/dev/null; then
    cp "${ONNX_OCR_DOWNLOADS}/${cached}" "$work/${cached}"
  else
    fetch "$work/${cached}" "$url"
  fi
  echo "${sum}  $work/${cached}" | sha256sum --check --strict -
  if [ -n "${ONNX_OCR_DOWNLOADS:-}" ]; then
    mkdir -p "$ONNX_OCR_DOWNLOADS"
    cp "$work/${cached}" "${ONNX_OCR_DOWNLOADS}/${cached}"
  fi
  mkdir -p "$(dirname "${INSTALL_DIR}/${target}")"
  install -m 0644 "$work/${cached}" "${INSTALL_DIR}/${target}"
}

install_file() {
  install_from "${ONNX_OCR_BASE}/$1" "$2" "$3"
}

install_file "$DET_PATH" "$DET_SHA256" det.onnx
install_file "$REC_PATH" "$REC_SHA256" rec.onnx
install_file "$DICT_PATH" "$DICT_SHA256" dict.txt

install_from "https://raw.githubusercontent.com/microsoft/onnxruntime/${ORT_COMMIT}/LICENSE" "$ORT_LICENSE_SHA256" licenses/onnxruntime.LICENSE
install_from "https://raw.githubusercontent.com/microsoft/onnxruntime/${ORT_COMMIT}/ThirdPartyNotices.txt" "$ORT_NOTICES_SHA256" licenses/onnxruntime.ThirdPartyNotices.txt
install_from "https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/${PADDLEOCR_COMMIT}/LICENSE" "$PADDLEOCR_LICENSE_SHA256" licenses/paddleocr.LICENSE
install_from "https://raw.githubusercontent.com/RapidAI/RapidOCR/${RAPIDOCR_COMMIT}/LICENSE" "$RAPIDOCR_LICENSE_SHA256" licenses/rapidocr.LICENSE

cat > "${INSTALL_DIR}/NOTICE" <<NOTICE
ONNX Korean OCR models

det.onnx   PP-OCRv5 mobile text detector (ch_PP-OCRv5_det_mobile)      sha256 ${DET_SHA256}
rec.onnx   PP-OCRv5 Korean mobile text recognizer                      sha256 ${REC_SHA256}
dict.txt   the recognizer's character list                             sha256 ${DICT_SHA256}

The weights are PaddleOCR's (PaddlePaddle authors, Apache License 2.0). The ONNX files and the character list are the conversion
published by the RapidOCR project (Apache License 2.0), release ${ONNX_OCR_RELEASE}:
  ${ONNX_OCR_BASE}/${DET_PATH}
  ${ONNX_OCR_BASE}/${REC_PATH}
  ${ONNX_OCR_BASE}/${DICT_PATH}
They are read as data by onnxruntime ${ORT_VERSION} (MIT, Microsoft Corporation), whose native library is statically built from libraries that
have notices of their own.

Licence texts, in the directory licenses/ beside this file:
  paddleocr.LICENSE                  Apache License 2.0 of PaddleOCR (tag ${PADDLEOCR_TAG}, commit ${PADDLEOCR_COMMIT})
  rapidocr.LICENSE                   Apache License 2.0 of RapidOCR (release ${ONNX_OCR_RELEASE}, commit ${RAPIDOCR_COMMIT})
  onnxruntime.LICENSE                MIT licence of onnxruntime (commit ${ORT_COMMIT}, tag v${ORT_VERSION})
  onnxruntime.ThirdPartyNotices.txt  notices of the libraries built into the onnxruntime library (same commit)
Neither PaddleOCR nor RapidOCR publishes a NOTICE file, so there is none to carry. The worker image copies these files to /licenses with the
prefix onnx-ocr. .
NOTICE
echo "installed the ONNX OCR models in ${INSTALL_DIR}"
