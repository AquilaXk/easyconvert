#!/usr/bin/env python3
"""Regenerates the OpenEXR golden corpus in this directory with the OpenEXR reference library.

Requirements:  pip install "OpenEXR>=3.3" numpy ; apt-get install openexr  (for exrmaketiled)
Command:       python3 tests/fixtures/exr/generate-exr-fixtures.py

Every .exr here is written by the reference OpenEXR implementation (the Python binding of
Academy Software Foundation OpenEXR), never by this repository's own encoder. The expected pixels
(*.f32, interleaved little-endian float32 R,G,B in dataWindow row-major order) are read back from
the written files with the same reference library, so they are an independent decode. The script
also asserts that lossless files decode to the deterministic source image.

manifest.json lists each fixture with its compression, storage, level mode and expected pixel file.
"""

import hashlib
import json
import os
import subprocess
import sys

import numpy as np
import OpenEXR

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
WIDTH = 37
HEIGHT = 45
# A non-zero dataWindow origin proves the decoder honours the window offset, not just its size.
X_MIN = -7
Y_MIN = 11
TILE_SIZE = 16
UINT_MODULUS = 70000
NOISE_SEED = 20240611
NOISE_BAND_WIDTH = 3


def source_image():
    """Deterministic HDR-like RGB image: peak above 1, negative values and a full-precision noisy band.

    Negative samples are confined to the noisy band: PIZ works on raw half bit patterns, so a
    gradient crossing zero would defeat its compression for the whole block.

    The coarse part (stepped gradients and a stepped Gaussian blob, few distinct values) lets every codec actually shrink the blocks
    (a codec stores a block raw when compression does not help, which would bypass the decoder
    under test); the right-hand band carries full float32 mantissas so FLOAT precision is verified.
    """
    ys, xs = np.mgrid[0:HEIGHT, 0:WIDTH].astype(np.float32)
    rng = np.random.RandomState(NOISE_SEED)
    noise = (rng.rand(HEIGHT, WIDTH, 3).astype(np.float32) - 0.5) * 0.03125
    noise[:, : WIDTH - NOISE_BAND_WIDTH, :] = 0.0
    r = np.round(8.0 * np.exp(-((xs - 18.0) ** 2 + (ys - 22.0) ** 2) / 80.0) * 4.0) / 4.0
    g = np.floor(ys / 8.0) / 8.0 + 0.25
    b = np.floor(xs / 6.0) / 8.0 + 0.125
    b[:, WIDTH - NOISE_BAND_WIDTH :] = 0.0  # the noise band below then holds negative values
    rgb = np.stack([r, g, b], axis=2).astype(np.float32) + noise
    return rgb.astype(np.float32)


def window(width, height):
    return (
        np.array([X_MIN, Y_MIN], dtype="int32"),
        np.array([X_MIN + width - 1, Y_MIN + height - 1], dtype="int32"),
    )


def base_header(compression, storage=OpenEXR.scanlineimage):
    return {
        "compression": compression,
        "type": storage,
        "dataWindow": window(WIDTH, HEIGHT),
        "displayWindow": (np.array([0, 0], dtype="int32"), np.array([WIDTH - 1, HEIGHT - 1], dtype="int32")),
    }


def tiled_header(compression, mode, tile_x=TILE_SIZE, tile_y=TILE_SIZE):
    header = base_header(compression, OpenEXR.tiledimage)
    tiles = OpenEXR.TileDescription()
    tiles.xSize = tile_x
    tiles.ySize = tile_y
    tiles.mode = mode
    tiles.roundingMode = OpenEXR.ROUND_DOWN
    header["tiles"] = tiles
    return header


def read_rgb(path, names):
    """Independent decode through the reference reader. Returns interleaved float32 R,G,B."""
    channels = OpenEXR.File(path).channels()
    if "RGB" in channels:
        planes = channels["RGB"].pixels
        return np.ascontiguousarray(planes.astype(np.float32))
    if "RGBA" in channels and tuple(names) == ("R", "G", "B"):
        planes = channels["RGBA"].pixels[:, :, :3]
        return np.ascontiguousarray(planes.astype(np.float32))
    layer = names[0].rsplit(".", 1)[0] if "." in names[0] else None
    if layer is not None and layer in channels:
        # The reference reader groups a layer's R,G,B channels under the layer name.
        return np.ascontiguousarray(channels[layer].pixels[:, :, :3].astype(np.float32))
    planes = [channels[name].pixels.astype(np.float32) for name in names]
    return np.ascontiguousarray(np.stack(planes, axis=2))


def to_gray_rgb(plane):
    return np.ascontiguousarray(np.stack([plane, plane, plane], axis=2).astype(np.float32))


COMPRESSIONS = {
    "none": OpenEXR.NO_COMPRESSION,
    "rle": OpenEXR.RLE_COMPRESSION,
    "zips": OpenEXR.ZIPS_COMPRESSION,
    "zip": OpenEXR.ZIP_COMPRESSION,
    "pxr24": OpenEXR.PXR24_COMPRESSION,
    "piz": OpenEXR.PIZ_COMPRESSION,
}

LEVEL_MODES = {
    "one": OpenEXR.ONE_LEVEL,
    "mipmap": OpenEXR.MIPMAP_LEVELS,
    "ripmap": OpenEXR.RIPMAP_LEVELS,
}

manifest = {"width": WIDTH, "height": HEIGHT, "xMin": X_MIN, "yMin": Y_MIN, "fixtures": [], "goldens": {}}
goldens = {}


def register_golden(key, rgb):
    data = np.ascontiguousarray(rgb, dtype="<f4").tobytes()
    name = "golden-%s.f32" % key
    if key in goldens:
        if goldens[key] != data:
            sys.exit("golden %s differs between fixtures that must decode identically" % key)
    else:
        goldens[key] = data
        with open(os.path.join(OUT_DIR, name), "wb") as handle:
            handle.write(data)
        manifest["goldens"][name] = hashlib.sha256(data).hexdigest()
    return name


def emit(name, header, channels, golden_key, expected_source=None, rgb_names=("R", "G", "B"), **meta):
    """Writes a fixture, reads it back with the reference decoder and records its golden file."""
    path = os.path.join(OUT_DIR, name)
    OpenEXR.File(header, channels).write(path)
    decoded = read_rgb(path, rgb_names)
    if expected_source is not None and not np.array_equal(decoded, expected_source):
        sys.exit("%s: reference decode differs from the lossless source" % name)
    golden = register_golden(golden_key, decoded)
    entry = {"file": name, "golden": golden}
    entry.update(meta)
    manifest["fixtures"].append(entry)


src = source_image()
src_half = src.astype(np.float16)
src_half_f32 = src_half.astype(np.float32)

# --- Scanline files: every compression, HALF and FLOAT RGB ---
for label, compression in COMPRESSIONS.items():
    emit(
        "scanline-%s-half.exr" % label,
        base_header(compression),
        {"RGB": src_half},
        "rgb-half",
        expected_source=src_half_f32,
        compression=label,
        layout="scanline",
        sample="half",
        lossy=False,
    )
    lossy = label == "pxr24"
    emit(
        "scanline-%s-float.exr" % label,
        base_header(compression),
        {"RGB": src},
        "rgb-float-pxr24" if lossy else "rgb-float",
        expected_source=None if lossy else src,
        compression=label,
        layout="scanline",
        sample="float",
        lossy=lossy,
    )

# --- UINT colour channels ---
ys_i, xs_i = np.mgrid[0:HEIGHT, 0:WIDTH]
uint_planes = {
    name: ((xs_i * 977 + ys_i * 131 + index * 1000003) % UINT_MODULUS).astype(np.uint32)
    for index, name in enumerate(("R", "G", "B"))
}
uint_rgb = np.stack([uint_planes[n].astype(np.float32) for n in ("R", "G", "B")], axis=2)
for label in ("zip", "piz", "pxr24"):
    emit(
        "scanline-%s-uint.exr" % label,
        base_header(COMPRESSIONS[label]),
        dict(uint_planes),
        "rgb-uint",
        expected_source=uint_rgb,
        compression=label,
        layout="scanline",
        sample="uint",
        lossy=False,
    )

# --- Extra channels of every type next to RGB: names and types must not shift the colour data ---
alpha = (np.mgrid[0:HEIGHT, 0:WIDTH][1] / float(WIDTH - 1)).astype(np.float16)
depth = (1.0 + np.mgrid[0:HEIGHT, 0:WIDTH][1] + np.mgrid[0:HEIGHT, 0:WIDTH][0] * 0.5).astype(np.float32)
ident = (np.mgrid[0:HEIGHT, 0:WIDTH][0] * WIDTH + np.mgrid[0:HEIGHT, 0:WIDTH][1]).astype(np.uint32)
for label in ("none", "zip", "pxr24", "piz"):
    emit(
        "scanline-%s-mixed-channels.exr" % label,
        base_header(COMPRESSIONS[label]),
        {"RGB": src_half, "A": alpha, "Z": depth, "id": ident},
        "rgb-half",
        expected_source=src_half_f32,
        compression=label,
        layout="scanline",
        sample="half",
        lossy=False,
        channelNames="A,B,G,R,Z,id",
    )

# --- Layered names: colour lives in a named layer, the root layer only carries alpha ---
emit(
    "scanline-piz-layered.exr",
    base_header(COMPRESSIONS["piz"]),
    {
        "A": alpha,
        "diffuse.R": np.ascontiguousarray(src_half[:, :, 0]),
        "diffuse.G": np.ascontiguousarray(src_half[:, :, 1]),
        "diffuse.B": np.ascontiguousarray(src_half[:, :, 2]),
    },
    "rgb-half",
    expected_source=src_half_f32,
    rgb_names=("diffuse.R", "diffuse.G", "diffuse.B"),
    compression="piz",
    layout="scanline",
    sample="half",
    lossy=False,
    channelNames="A,diffuse.B,diffuse.G,diffuse.R",
)

# --- Single luminance channel decodes to equal R,G,B ---
luma = (src[:, :, 0] * 0.3 + src[:, :, 1] * 0.6 + src[:, :, 2] * 0.1).astype(np.float16)
for label in ("zip", "piz"):
    emit(
        "scanline-%s-gray.exr" % label,
        base_header(COMPRESSIONS[label]),
        {"Y": luma},
        "gray-half",
        expected_source=to_gray_rgb(luma.astype(np.float32)),
        rgb_names=("Y", "Y", "Y"),
        compression=label,
        layout="scanline",
        sample="half",
        lossy=False,
        channelNames="Y",
    )

# --- Tiled files (single part) ---
for label in COMPRESSIONS:
    emit(
        "tiled-%s-half-one-level.exr" % label,
        tiled_header(COMPRESSIONS[label], LEVEL_MODES["one"]),
        {"RGB": src_half},
        "rgb-half",
        expected_source=src_half_f32,
        compression=label,
        layout="tiled",
        levelMode="one",
        sample="half",
        lossy=False,
    )
# MIPMAP/RIPMAP files need every resolution level written, which the Python binding cannot do,
# so the reference `exrmaketiled` tool (apt package `openexr`) tiles a scanline source instead.
MAKETILED_LEVEL_FLAG = {"mipmap": "-m", "ripmap": "-r"}


def emit_multilevel(name, mode, compression_label, samples, sample_label, golden_key, expected_source):
    scratch = os.path.join(OUT_DIR, "scratch-source.exr")
    OpenEXR.File(base_header(COMPRESSIONS["none"]), {"RGB": samples}).write(scratch)
    path = os.path.join(OUT_DIR, name)
    subprocess.run(
        [
            "exrmaketiled",
            MAKETILED_LEVEL_FLAG[mode],
            "-t", str(TILE_SIZE), str(TILE_SIZE),
            "-z", compression_label,
            scratch,
            path,
        ],
        check=True,
    )
    os.remove(scratch)
    decoded = read_rgb(path, ("R", "G", "B"))
    if not np.array_equal(decoded, expected_source):
        sys.exit("%s: reference decode of level 0 differs from the lossless source" % name)
    manifest["fixtures"].append(
        {
            "file": name,
            "golden": register_golden(golden_key, decoded),
            "compression": compression_label,
            "layout": "tiled",
            "levelMode": mode,
            "sample": sample_label,
            "lossy": False,
        }
    )


emit_multilevel("tiled-zip-float-mipmap.exr", "mipmap", "zip", src, "float", "rgb-float", src)
emit_multilevel("tiled-piz-half-mipmap.exr", "mipmap", "piz", src_half, "half", "rgb-half", src_half_f32)
emit_multilevel("tiled-zip-half-ripmap.exr", "ripmap", "zip", src_half, "half", "rgb-half", src_half_f32)
emit(
    "tiled-piz-float-20x12.exr",
    tiled_header(COMPRESSIONS["piz"], LEVEL_MODES["one"], 20, 12),
    {"RGB": src},
    "rgb-float",
    expected_source=src,
    compression="piz",
    layout="tiled",
    levelMode="one",
    sample="float",
    lossy=False,
)

# --- PIZ image whose half samples need the 16-bit wavelet and Huffman codes over 14 bits ---
# A ramp of distinct half bit patterns uses more than 2**14 distinct values, which selects the
# 16-bit (modulo) wavelet instead of the 14-bit one, and its many near-equal symbol frequencies
# give Huffman codes longer than the 14-bit direct lookup table. The window origin and a height that
# leaves a partial 32-row block exercise offsets and the short last block.
WIDE_WIDTH = 600
WIDE_HEIGHT = 33
WIDE_X_MIN = -5
WIDE_Y_MIN = 3
WIDE_STEP = 29
HALF_MAX_FINITE_BITS = 0x7BFF
WIDE_CHANNEL_OFFSETS = (0, 5, 11)


def wide_value_ramp():
    ys, xs = np.mgrid[0:WIDE_HEIGHT, 0:WIDE_WIDTH]
    bits = np.zeros((WIDE_HEIGHT, WIDE_WIDTH, 3), dtype=np.uint16)
    for channel, offset in enumerate(WIDE_CHANNEL_OFFSETS):
        bits[:, :, channel] = np.minimum(xs * WIDE_STEP + ys + offset, HALF_MAX_FINITE_BITS)
    return bits.view(np.float16)


wide_ramp = wide_value_ramp()
wide_header = base_header(COMPRESSIONS["piz"])
wide_header["dataWindow"] = (
    np.array([WIDE_X_MIN, WIDE_Y_MIN], dtype="int32"),
    np.array([WIDE_X_MIN + WIDE_WIDTH - 1, WIDE_Y_MIN + WIDE_HEIGHT - 1], dtype="int32"),
)
wide_header["displayWindow"] = (
    np.array([0, 0], dtype="int32"),
    np.array([WIDE_WIDTH - 1, WIDE_HEIGHT - 1], dtype="int32"),
)
emit(
    "scanline-piz-half-wide-values.exr",
    wide_header,
    {"RGB": wide_ramp},
    "ramp-half",
    expected_source=wide_ramp.astype(np.float32),
    compression="piz",
    layout="scanline",
    sample="half",
    lossy=False,
    width=WIDE_WIDTH,
    height=WIDE_HEIGHT,
    xMin=WIDE_X_MIN,
    yMin=WIDE_Y_MIN,
    wideValues=True,
)

# --- Inputs the decoder must reject with a typed error ---
reject = []


def emit_reject(name, header, channels, reason):
    OpenEXR.File(header, channels).write(os.path.join(OUT_DIR, name))
    reject.append({"file": name, "reason": reason})


for label, compression in (
    ("dwaa", OpenEXR.DWAA_COMPRESSION),
    ("dwab", OpenEXR.DWAB_COMPRESSION),
    ("b44", OpenEXR.B44_COMPRESSION),
    ("b44a", OpenEXR.B44A_COMPRESSION),
):
    emit_reject("reject-%s.exr" % label, base_header(compression), {"RGB": src_half}, label)

emit_reject(
    "reject-luma-chroma.exr",
    base_header(COMPRESSIONS["zip"]),
    {"Y": luma, "RY": luma, "BY": luma},
    "luma-chroma",
)
emit_reject("reject-no-color.exr", base_header(COMPRESSIONS["zip"]), {"Z": depth}, "no-color")
manifest["reject"] = reject

with open(os.path.join(OUT_DIR, "manifest.json"), "w") as handle:
    json.dump(manifest, handle, indent=2, sort_keys=True)
    handle.write("\n")
print("wrote %d fixtures, %d goldens, %d reject files" % (len(manifest["fixtures"]), len(goldens), len(reject)))
