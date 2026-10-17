"""Facts of a font file read by fontTools, an independent font library: glyph count, family name and, for every glyph, its advance width, outline area and bounding box in 1000-unit em coordinates.

Usage: font_outline_facts.py type1 FILE   (a PFA or PFB file, read by fontTools.t1Lib)
       font_outline_facts.py sfnt FILE    (a TTF, OTF, WOFF or WOFF2 file, read by fontTools.ttLib)

Glyphs are listed in no order that depends on the file's glyph order: the caller compares the multiset of outlines, because a converter may rename or reorder glyphs.
"""
import json
import sys

from fontTools import t1Lib
from fontTools.pens.areaPen import AreaPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont

EM_UNITS = 1000


def glyph_facts(glyph_set, name, scale):
    glyph = glyph_set[name]
    area = AreaPen(glyph_set)
    glyph.draw(area)
    bounds = BoundsPen(glyph_set)
    glyph.draw(bounds)
    box = None if bounds.bounds is None else [value * scale for value in bounds.bounds]
    return {"name": name, "width": glyph.width * scale, "area": abs(area.value) * scale * scale, "bbox": box}


def type1_facts(path):
    font = t1Lib.T1Font(path)
    font.parse()
    glyph_set = font.getGlyphSet()
    names = sorted(font.font["CharStrings"].keys())
    return {
        "fontName": font.font["FontName"],
        "familyName": font.font["FontInfo"]["FamilyName"],
        "glyphCount": len(names),
        "glyphs": [glyph_facts(glyph_set, name, 1.0) for name in names],
    }


def sfnt_facts(path):
    font = TTFont(path)
    glyph_set = font.getGlyphSet()
    scale = EM_UNITS / font["head"].unitsPerEm
    return {
        "flavor": font.sfntVersion,
        "familyName": font["name"].getDebugName(1),
        "glyphCount": font["maxp"].numGlyphs,
        "tables": sorted(font.keys()),
        "glyphs": [glyph_facts(glyph_set, name, scale) for name in font.getGlyphOrder()],
    }


KINDS = {"type1": type1_facts, "sfnt": sfnt_facts}

if __name__ == "__main__":
    print(json.dumps(KINDS[sys.argv[1]](sys.argv[2])))
