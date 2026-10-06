#!/usr/bin/env python3
"""Compares a font with the same font after a WOFF2 round trip, using fontTools only.

    woff2_compare.py <source.ttf|otf> <encoded.woff2>

Prints a JSON list of differences ([] when the WOFF2 file decodes to the source font). Glyphs are
compared as decompiled outlines (end points, coordinates, point flags, instructions, components,
bounding boxes), because the WOFF2 transform legitimately re-packs the glyf bytes; every other table
is compared byte for byte, except head, where the lossless-transform flag, the loca format and the
checksum adjustment may differ.
"""
import json
import sys

from fontTools.ttLib import TTFont

HEAD_FLAGS_LOSSLESS_TRANSFORM = 1 << 11
ON_CURVE_AND_OVERLAP = 0x41


def glyph_signature(glyph, glyf):
    if glyph.numberOfContours == 0:
        return ["empty"]
    program = glyph.program.getBytecode().hex() if hasattr(glyph, "program") else None
    if glyph.isComposite():
        return [
            "composite",
            [
                [c.glyphName, c.flags & ~0x0100, c.x, c.y, list(getattr(c, "transform", [[1, 0], [0, 1]]))]
                for c in glyph.components
            ],
            program,
            [glyph.xMin, glyph.yMin, glyph.xMax, glyph.yMax],
        ]
    coordinates, end_points, flags = glyph.getCoordinates(glyf)
    return [
        "simple",
        list(end_points),
        [list(point) for point in coordinates],
        [f & ON_CURVE_AND_OVERLAP for f in flags],
        program,
        [glyph.xMin, glyph.yMin, glyph.xMax, glyph.yMax],
    ]


def main():
    source = TTFont(sys.argv[1], lazy=True)
    encoded = TTFont(sys.argv[2], lazy=True)
    problems = []
    # the encoder drops DSIG: the transform invalidates the signature
    source_tags = sorted(tag for tag in source.reader.keys() if tag != "DSIG")
    encoded_tags = sorted(encoded.reader.keys())
    if source_tags != encoded_tags:
        problems.append(["tables", source_tags, encoded_tags])
    for tag in source_tags:
        if tag in ("glyf", "loca", "head") or tag not in encoded_tags:
            continue
        if source.reader[tag] != encoded.reader[tag]:
            problems.append(["table bytes differ", tag])
    if "glyf" in source_tags:
        source_glyf = TTFont(sys.argv[1])
        encoded_glyf = TTFont(sys.argv[2])
        order = source_glyf.getGlyphOrder()
        if order != encoded_glyf.getGlyphOrder():
            problems.append(["glyph order"])
        for name in order:
            a = glyph_signature(source_glyf["glyf"][name], source_glyf["glyf"])
            b = glyph_signature(encoded_glyf["glyf"][name], encoded_glyf["glyf"])
            if a != b:
                problems.append(["glyph", name, a, b])
        for name in order:
            if source_glyf["hmtx"][name] != encoded_glyf["hmtx"][name]:
                problems.append(["hmtx", name])
    source_head = source["head"]
    encoded_head = encoded["head"]
    for field in ("unitsPerEm", "xMin", "yMin", "xMax", "yMax", "macStyle", "lowestRecPPEM", "fontDirectionHint", "glyphDataFormat", "created", "modified", "fontRevision", "magicNumber"):
        if getattr(source_head, field) != getattr(encoded_head, field):
            problems.append(["head", field])
    if not encoded_head.flags & HEAD_FLAGS_LOSSLESS_TRANSFORM:
        problems.append(["head", "bit 11 of flags is not set"])
    if (source_head.flags | HEAD_FLAGS_LOSSLESS_TRANSFORM) != encoded_head.flags:
        problems.append(["head", "flags other than bit 11 changed"])
    json.dump(problems, sys.stdout)


if __name__ == "__main__":
    main()
