#!/usr/bin/env python3
"""Writes the benchmark corpus files that need a library or tool with no deterministic mode (see PROVENANCE.md).

    python3 -I generate-assets.py <corpus-dir>

Requires pyarrow, openpyxl, fontTools and, for the MOBI file, calibre's `ebook-convert`; the table (data/table.jsonl) and
the EPUB (ebooks/book.epub) come from generate.ts first. The committed bytes are the record: manifest.json pins them.
"""
import json
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import openpyxl
import pyarrow as pa
import pyarrow.parquet as pq
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.subset import Options, Subsetter, load_font, save_font
from fontTools.ttLib import TTFont

DEJAVU_SANS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "/Library/Fonts/DejaVuSans.ttf",
]
FIXED_TIMESTAMP = 3600000000  # seconds since 1904, only here to keep the fonts reproducible
ROW_GROUP_ROWS = 1000
TOOL_TIMEOUT_SECONDS = 300
# Basic Latin, Latin-1, Latin Extended-A, Greek, Cyrillic and general punctuation: a text face of about 800 glyphs.
UNICODES = [*range(0x20, 0x7F), *range(0xA0, 0x180), *range(0x370, 0x400), *range(0x400, 0x460), *range(0x2010, 0x2028), 0x20AC, 0x2122]


def records(corpus):
    with open(corpus / "data" / "table.jsonl", encoding="utf-8") as handle:
        return [json.loads(line) for line in handle]


def make_parquet(corpus):
    rows = records(corpus)
    columns = {key: [row[key] for row in rows] for key in rows[0]}
    stamps = [datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc) for value in columns["ts"]]
    columns["ts"] = pa.array(stamps, type=pa.timestamp("ms", tz="UTC"))
    table = pa.table(columns)
    pq.write_table(table, corpus / "data" / "table.parquet", compression="snappy", row_group_size=ROW_GROUP_ROWS)


def make_xlsx(corpus):
    rows = records(corpus)
    workbook = openpyxl.Workbook(write_only=True)
    workbook.properties.creator = "bench"
    workbook.properties.created = datetime(2020, 1, 1)
    workbook.properties.modified = datetime(2020, 1, 1)
    sheet = workbook.create_sheet("table")
    header = list(rows[0])
    sheet.append(header)
    for row in rows:
        sheet.append([row[key] for key in header])
    workbook.save(corpus / "data" / "table.xlsx")


def subset_font(source, out):
    options = Options()
    options.layout_features = ["*"]
    options.hinting = True
    options.notdef_outline = True
    options.recalc_timestamp = False
    options.name_IDs = ["*"]
    font = load_font(source, options)
    subsetter = Subsetter(options)
    subsetter.populate(unicodes=UNICODES)
    subsetter.subset(font)
    save_font(font, out, options)


def truetype_to_cff(source, out):
    """The same glyphs as a CFF-flavoured OpenType font: quadratic outlines drawn as exact cubic curves, no hinting."""
    ttf = TTFont(source)
    order = ttf.getGlyphOrder()
    glyph_set = ttf.getGlyphSet()
    strings = {}
    for name in order:
        pen = T2CharStringPen(glyph_set[name].width, glyph_set)
        glyph_set[name].draw(pen)
        strings[name] = pen.getCharString()
    names = ttf["name"]
    ps_name = names.getDebugName(6)
    builder = FontBuilder(ttf["head"].unitsPerEm, isTTF=False)
    builder.setupGlyphOrder(order)
    builder.setupCharacterMap(ttf.getBestCmap())
    builder.setupCFF(ps_name, {"FullName": names.getDebugName(4), "FamilyName": names.getDebugName(1), "Weight": "Book"}, strings, {})
    builder.setupHorizontalMetrics({name: ttf["hmtx"][name] for name in order})
    hhea = ttf["hhea"]
    builder.setupHorizontalHeader(ascent=hhea.ascent, descent=hhea.descent, lineGap=hhea.lineGap)
    builder.setupNameTable({"familyName": names.getDebugName(1), "styleName": names.getDebugName(2)})
    os2 = ttf["OS/2"]
    builder.setupOS2(**{key: getattr(os2, key) for key in ("sTypoAscender", "sTypoDescender", "sTypoLineGap", "usWinAscent", "usWinDescent", "usWeightClass", "fsType") if hasattr(os2, key)})
    builder.setupPost()
    builder.setupHead(unitsPerEm=ttf["head"].unitsPerEm, created=FIXED_TIMESTAMP, modified=FIXED_TIMESTAMP)
    for tag in ("GDEF", "GSUB", "GPOS"):
        if tag in ttf:
            builder.font[tag] = ttf[tag]
    builder.save(out)


def make_fonts(corpus):
    source = next((path for path in DEJAVU_SANS if Path(path).exists()), None)
    if source is None:
        raise SystemExit("DejaVu Sans is not installed (fonts-dejavu-core)")
    out = corpus / "fonts"
    out.mkdir(exist_ok=True)
    subset_font(source, out / "sans.ttf")
    truetype_to_cff(out / "sans.ttf", out / "sans-cff.otf")


def make_mobi(corpus):
    converter = shutil.which("ebook-convert")
    if converter is None:
        raise SystemExit("calibre's ebook-convert is not installed")
    with tempfile.TemporaryDirectory() as home:
        subprocess.run(
            [converter, str(corpus / "ebooks" / "book.epub"), str(corpus / "ebooks" / "book.mobi"), "--mobi-file-type=old"],
            check=True,
            timeout=TOOL_TIMEOUT_SECONDS,
            env={"HOME": home, "PATH": "/usr/bin:/bin:/usr/local/bin", "QT_QPA_PLATFORM": "offscreen"},
            stdout=subprocess.DEVNULL,
        )


def main():
    corpus = Path(sys.argv[1])
    make_parquet(corpus)
    make_xlsx(corpus)
    make_fonts(corpus)
    make_mobi(corpus)


if __name__ == "__main__":
    main()
