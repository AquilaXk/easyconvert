"""Facts of a TTF, OTF, WOFF or WOFF2 file read by fontTools, an independent font library, for comparing a font with the one it was made from.

Usage: font_table_facts.py FILE

Prints the glyph count, the family name, the units per em, the ascent and descent of the horizontal header, the number of characters in the
best Unicode map with a digest of its character-to-glyph-index pairs, the sum of the advance widths, the advance of the glyph of "a" (null where the font maps none), and the
number of TrueType glyphs whose instructions do not disassemble (a decoder that misplaces the instruction bytes of a composite glyph leaves some).
"""
import hashlib
import json
import sys

from fontTools.ttLib import TTFont


def undecodable_glyph_programs(font):
    if "glyf" not in font:
        return 0
    glyf = font["glyf"]
    broken = 0
    for name in font.getGlyphOrder():
        program = getattr(glyf[name], "program", None)
        if program is None:
            continue
        try:
            program.fromBytecode(program.getBytecode())
            program.getAssembly()
        except Exception:
            broken += 1
    return broken


def facts(path):
    font = TTFont(path)
    cmap = font.getBestCmap()
    order = font.getGlyphOrder()
    index = {name: number for number, name in enumerate(order)}
    pairs = "".join("%d:%d;" % (code, index[cmap[code]]) for code in sorted(cmap))
    metrics = font["hmtx"].metrics
    return {
        "flavor": font.sfntVersion,
        "glyphCount": font["maxp"].numGlyphs,
        "familyName": font["name"].getDebugName(1),
        "unitsPerEm": font["head"].unitsPerEm,
        "ascent": font["hhea"].ascent,
        "descent": font["hhea"].descent,
        "cmapSize": len(cmap),
        "cmapDigest": hashlib.sha256(pairs.encode()).hexdigest(),
        "advanceSum": sum(width for width, _ in metrics.values()),
        "advanceOfA": metrics[cmap[ord("a")]][0] if ord("a") in cmap else None,
        "undecodableGlyphPrograms": undecodable_glyph_programs(font),
    }


if __name__ == "__main__":
    print(json.dumps(facts(sys.argv[1])))
