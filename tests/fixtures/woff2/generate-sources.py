#!/usr/bin/env python3
"""Builds the source fonts of the WOFF2 conformance fixtures (see PROVENANCE.txt).

Requires fontTools. The reference WOFF2 files are made from these sources by independent tools
(woff2_compress, woff2_decompress and fontTools), never by this repository's own encoder.

    python3 generate-sources.py <output-dir>
"""
import sys
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.subset import Options, Subsetter, load_font, save_font
from fontTools.ttLib import TTCollection, TTFont, newTable
from fontTools.ttLib.tables import ttProgram
from fontTools.ttLib.tables._g_l_y_f import flagOverlapSimple

FIXED_TIMESTAMP = 3600000000  # seconds since 1904, only here to keep the sources reproducible
DEJAVU_SANS = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
DEJAVU_SERIF = "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"


def subset(source, unicodes, out, hinting):
    options = Options()
    options.layout_features = ["kern", "liga"]
    options.hinting = hinting
    options.notdef_outline = True
    options.recalc_timestamp = False
    font = load_font(source, options)
    subsetter = Subsetter(options)
    subsetter.populate(unicodes=unicodes)
    subsetter.subset(font)
    save_font(font, out, options)


def polygon(pen, points):
    pen.moveTo(points[0])
    for point in points[1:]:
        pen.lineTo(point)
    pen.closePath()


def circle_points(count, radius, cx, cy):
    import math

    return [
        (round(cx + radius * math.cos(2 * math.pi * i / count)), round(cy + radius * math.sin(2 * math.pi * i / count)))
        for i in range(count)
    ]


def build_triplet_font(path):
    """A TrueType font whose glyphs reach every coordinate encoding of the WOFF2 glyf transform."""
    glyph_order = [".notdef", "space", "tiny", "axis", "mid", "wide", "huge", "rings", "hinted", "long", "composite", "scaled"]
    glyphs = {}

    def simple(draw):
        pen = TTGlyphPen(None)
        draw(pen)
        return pen.glyph()

    glyphs[".notdef"] = simple(lambda p: polygon(p, [(50, 0), (50, 700), (450, 700), (450, 0)]))
    glyphs["space"] = TTGlyphPen(None).glyph()

    def tiny(pen):
        # steps of 1..64 in both axes, on and off curve points
        pen.moveTo((100, 100))
        pen.qCurveTo((110, 110), (140, 105))
        pen.lineTo((160, 170))
        pen.lineTo((130, 230))
        pen.lineTo((70, 200))
        pen.closePath()

    glyphs["tiny"] = simple(tiny)

    def axis(pen):
        # deltas along one axis only, up to 1279 (the one-byte-plus-high-bits forms)
        polygon(pen, [(0, 0), (0, 5), (300, 5), (300, 1200), (-200, 1200), (-200, 1279), (-1100, 1279)])

    glyphs["axis"] = simple(axis)

    def mid(pen):
        # steps between 65 and 768 in both axes
        polygon(pen, [(0, 0), (300, 200), (700, 650), (200, 1100), (-400, 700), (-500, 100)])

    glyphs["mid"] = simple(mid)

    def wide(pen):
        # steps up to 4095
        polygon(pen, [(0, 0), (2000, 1500), (5000, 1500), (4000, 5200), (-1000, 4000)])

    glyphs["wide"] = simple(wide)

    def huge(pen):
        # steps past 4095 (four byte form), reaching the int16 limits
        polygon(pen, [(-16000, -16000), (16000, -15000), (15000, 16000), (-15000, 15000)])

    glyphs["huge"] = simple(huge)

    def rings(pen):
        polygon(pen, circle_points(300, 900, 1000, 1000))  # more than 252 points: multi byte 255UInt16
        polygon(pen, circle_points(40, 500, 1000, 1000)[::-1])

    glyphs["rings"] = simple(rings)
    glyphs["rings"].flags[0] |= flagOverlapSimple  # exercises overlapSimpleBitmap

    def hinted(pen):
        polygon(pen, [(0, 0), (0, 600), (400, 600), (400, 0)])

    for name, length in (("hinted", 300), ("long", 600)):
        glyph = simple(hinted)
        glyph.program = ttProgram.Program()
        glyph.program.fromBytecode(bytes([0x00]) * length)  # SVTCA[y] repeated: valid, 300 and 600 byte programs
        glyphs[name] = glyph

    composite_pen = TTGlyphPen(glyphs)
    composite_pen.addComponent("tiny", (1, 0, 0, 1, 20, 30))
    composite_pen.addComponent("axis", (1, 0, 0, 1, 1200, -300))  # offsets past one byte: ARG_1_AND_2_ARE_WORDS
    glyphs["composite"] = composite_pen.glyph()
    glyphs["composite"].program = ttProgram.Program()
    glyphs["composite"].program.fromBytecode(bytes([0x00]) * 1000)  # composite instructions of 1000 bytes

    scaled_pen = TTGlyphPen(glyphs)
    scaled_pen.addComponent("mid", (0.5, 0, 0, 0.5, 0, 0))
    scaled_pen.addComponent("tiny", (1, 0.25, -0.25, 1, 10, 10))
    glyphs["scaled"] = scaled_pen.glyph()

    builder = FontBuilder(1000, isTTF=True)
    builder.setupGlyphOrder(glyph_order)
    builder.setupCharacterMap({0x20: "space", 0x41: "tiny", 0x42: "axis", 0x43: "mid", 0x44: "wide", 0x45: "huge", 0x46: "rings", 0x47: "hinted", 0x48: "long", 0x49: "composite", 0x4A: "scaled"})
    builder.setupGlyf(glyphs)
    # sidebearings equal to xMin everywhere except one glyph, so the hmtx transform needs the lsb[] array only;
    # the last four glyphs share one advance width, so they are stored as bare left side bearings
    advance = {name: 600 for name in glyph_order}
    advance.update({"space": 250, "tiny": 400, "axis": 800, "mid": 900, "wide": 1500})
    metrics = {}
    glyf = builder.font["glyf"]
    for name in glyph_order:
        glyph = glyphs[name]
        glyph.recalcBounds(glyf)
        metrics[name] = (advance[name], getattr(glyph, "xMin", 0))
    metrics["mid"] = (advance["mid"], metrics["mid"][1] + 3)
    builder.setupHorizontalMetrics(metrics)
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupNameTable({"familyName": "Conformance Triplets", "styleName": "Regular"})
    builder.setupOS2(sTypoAscender=800, usWinAscent=800, usWinDescent=200)
    builder.setupPost()
    builder.setupHead(unitsPerEm=1000, created=FIXED_TIMESTAMP, modified=FIXED_TIMESTAMP)
    builder.save(path)


def build_cff_font(path):
    glyph_order = [".notdef", "A", "B", "C"]
    charstrings = {}

    def make(points, width):
        pen = T2CharStringPen(width, None)
        polygon(pen, points)
        return pen.getCharString()

    widths = {".notdef": 500, "A": 600, "B": 560, "C": 580}
    charstrings[".notdef"] = make([(50, 0), (50, 700), (450, 700), (450, 0)], widths[".notdef"])
    charstrings["A"] = make([(20, 0), (300, 700), (580, 0)], widths["A"])
    charstrings["B"] = make([(80, 0), (80, 700), (480, 700), (480, 0)], widths["B"])
    charstrings["C"] = make([(40, 10), (40, 690), (520, 690), (520, 10)], widths["C"])
    builder = FontBuilder(1000, isTTF=False)
    builder.setupGlyphOrder(glyph_order)
    builder.setupCharacterMap({0x41: "A", 0x42: "B", 0x43: "C"})
    builder.setupCFF("ConformanceCFF-Regular", {"FullName": "Conformance CFF Regular"}, charstrings, {})
    builder.setupHorizontalMetrics({name: (widths[name], 20) for name in glyph_order})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupNameTable({"familyName": "Conformance CFF", "styleName": "Regular"})
    builder.setupOS2(sTypoAscender=800, usWinAscent=800, usWinDescent=200)
    builder.setupPost()
    builder.setupHead(unitsPerEm=1000, created=FIXED_TIMESTAMP, modified=FIXED_TIMESTAMP)
    builder.save(path)


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    latin = [*range(0x20, 0x7F), *range(0xC0, 0x100)]
    subset(DEJAVU_SANS, latin, out / "dejavu-sans-latin.ttf", hinting=False)
    subset(DEJAVU_SERIF, list(range(0x20, 0x7F)), out / "dejavu-serif-hinted-ascii.ttf", hinting=True)
    build_triplet_font(out / "synthetic-triplets.ttf")
    build_cff_font(out / "synthetic-cff.otf")
    collection = TTCollection()
    collection.fonts = [TTFont(out / "dejavu-sans-latin.ttf"), TTFont(out / "synthetic-triplets.ttf")]
    collection.save(out / "pair.ttc", shareTables=True)


if __name__ == "__main__":
    main()
