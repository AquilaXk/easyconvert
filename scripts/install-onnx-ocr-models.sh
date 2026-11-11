#!/usr/bin/env bash
# Installs the models of the ONNX Korean OCR engine (src/lib/conversions/ocr-onnx.ts): the PP-OCRv5 mobile text detector, the PP-OCRv5
# Korean mobile line recognizer and the recognizer's character list. The weights are PaddleOCR's (Apache-2.0), converted to ONNX and
# published by the RapidOCR project (Apache-2.0) at a tagged release; they are data read by onnxruntime, never code that runs. Each file is
# verified against a fixed SHA-256 before it is copied, and the three are written under the names the engine reads (det.onnx, rec.onnx,
# dict.txt) beside a NOTICE that says where they come from and under which licence.
#
# Bump ONNX_OCR_RELEASE and the three digests together, and run tests/ocr-onnx-real.test.ts with the new files before moving the pin.
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
# The largest file is 13.5 MB. curl refuses a download announced as larger, and the read stops one byte past the bound.
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
install_file() {
  local remote="$1" sum="$2" target="$3" name
  name="$(basename "$remote")"
  if [ -n "${ONNX_OCR_DOWNLOADS:-}" ] && echo "${sum}  ${ONNX_OCR_DOWNLOADS}/${name}" | sha256sum --check --strict --status - 2>/dev/null; then
    cp "${ONNX_OCR_DOWNLOADS}/${name}" "$work/${name}"
  else
    fetch "$work/${name}" "${ONNX_OCR_BASE}/${remote}"
  fi
  echo "${sum}  $work/${name}" | sha256sum --check --strict -
  if [ -n "${ONNX_OCR_DOWNLOADS:-}" ]; then
    mkdir -p "$ONNX_OCR_DOWNLOADS"
    cp "$work/${name}" "${ONNX_OCR_DOWNLOADS}/${name}"
  fi
  mkdir -p "$INSTALL_DIR"
  install -m 0644 "$work/${name}" "${INSTALL_DIR}/${target}"
}

install_file "$DET_PATH" "$DET_SHA256" det.onnx
install_file "$REC_PATH" "$REC_SHA256" rec.onnx
install_file "$DICT_PATH" "$DICT_SHA256" dict.txt

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
They are read as data by onnxruntime (MIT). The licence texts are in docs/licensing.md of the source repository.
NOTICE
echo "installed the ONNX OCR models in ${INSTALL_DIR}"
