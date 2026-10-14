#!/usr/bin/env python3
"""Reference conversions and independent oracles of the data and font benchmark families.

Runs as `python3 -I reference-server.py` for the length of a family run, so that the reference libraries are imported once
and a timed reference call measures the conversion and not the interpreter start. One JSON object per line on stdin
({"id", "op", ...arguments}); one per line on stdout ({"id", "ok": true, "result"} or {"id", "ok": false, "error"}).

Reference tools: DuckDB (CSV and JSON), Apache Arrow (Parquet). Oracles: the Python standard library (csv, json), pyarrow and
DuckDB as two independent Parquet readers, openpyxl (XLSX), fontTools (fonts), ezdxf (the geometry and text of a DXF drawing),
olefile and xlrd (the text of Word, Excel and PowerPoint 97-2003 files). None of them is this project's code.
"""
import csv
import json
import sys
from datetime import date, datetime, timezone
from decimal import Decimal

OPS = {}


def op(name):
    def register(function):
        OPS[name] = function
        return function

    return register


_DUCKDB = None


def literal(text):
    """A SQL string literal; DuckDB takes no parameter for the path of a COPY."""
    return "'" + str(text).replace("'", "''") + "'"


def duckdb_connection():
    global _DUCKDB
    if _DUCKDB is None:
        import duckdb

        _DUCKDB = duckdb.connect()
    return _DUCKDB


# --------------------------------------------------------------------------------------------------------------------
# Data: reference conversions
# --------------------------------------------------------------------------------------------------------------------


@op("data.convert")
def data_convert(args):
    kind, src, dst = args["kind"], args["src"], args["dst"]
    if kind == "csv-json":
        duckdb_connection().execute("COPY (SELECT * FROM read_csv(%s)) TO %s (FORMAT JSON, ARRAY true)" % (literal(src), literal(dst)))
    elif kind == "jsonl-csv":
        duckdb_connection().execute("COPY (SELECT * FROM read_json(%s, format = 'newline_delimited')) TO %s (FORMAT CSV, HEADER)" % (literal(src), literal(dst)))
    elif kind == "json-csv":
        duckdb_connection().execute("COPY (SELECT * FROM read_json(%s)) TO %s (FORMAT CSV, HEADER)" % (literal(src), literal(dst)))
    elif kind == "parquet-json":
        duckdb_connection().execute("COPY (SELECT * FROM read_parquet(%s)) TO %s (FORMAT JSON, ARRAY true)" % (literal(src), literal(dst)))
    elif kind == "csv-parquet":
        import pyarrow.csv
        import pyarrow.parquet

        pyarrow.parquet.write_table(pyarrow.csv.read_csv(src), dst, compression="snappy")
    elif kind == "parquet-csv":
        import pyarrow.csv
        import pyarrow.parquet

        pyarrow.csv.write_csv(pyarrow.parquet.read_table(src), dst)
    else:
        raise ValueError("unknown conversion " + kind)
    return {}


# --------------------------------------------------------------------------------------------------------------------
# Data: oracles. Every cell of an output is rendered back to text and compared with the text of the source cell.
# --------------------------------------------------------------------------------------------------------------------

MISSING = "\x00missing\x00"


def render(value):
    """The text a cell reads as: what the source CSV or JSON line would hold for the same value."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, (float, Decimal)):
        number = float(value)
        return str(int(number)) if number.is_integer() and abs(number) < 1e15 else repr(number)
    if isinstance(value, datetime):
        stamp = value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return stamp.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (stamp.microsecond // 1000)
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, (bytes, bytearray)):
        try:
            return bytes(value).decode("utf-8")
        except UnicodeDecodeError:
            return str(value)
    return str(value)


def read_csv_text(path):
    with open(path, encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.reader(handle))
    return rows[0], rows[1:]


def read_truth(spec):
    if spec["kind"] == "csv":
        return read_csv_text(spec["file"])
    if spec["kind"] == "json":
        with open(spec["file"], encoding="utf-8") as handle:
            records = json.load(handle)
        header = []
        for record in records:
            header.extend(key for key in record if key not in header)
        return header, [[render(record.get(key)) for key in header] for record in records]
    if spec["kind"] == "parquet":
        # A Parquet file that has no text twin: DuckDB reads it (or pyarrow when the file uses an encoding DuckDB does not read), and the outputs are read by pyarrow and DuckDB and by the text readers.
        import duckdb

        try:
            return read_parquet_duckdb(spec["file"])
        except duckdb.Error:
            return read_parquet_pyarrow(spec["file"])
    with open(spec["file"], encoding="utf-8") as handle:
        records = [json.loads(line) for line in handle if line.strip()]
    header = list(records[0])
    return header, [[render(record.get(key)) for key in header] for record in records]


def read_json_output(path, header):
    with open(path, encoding="utf-8") as handle:
        records = json.load(handle)
    return header, [[render(record[key]) if key in record else MISSING for key in header] for record in records]


def read_parquet_pyarrow(path):
    import pyarrow.parquet

    table = pyarrow.parquet.read_table(path)
    columns = [column.to_pylist() for column in table.columns]
    return table.column_names, [[render(column[row]) for column in columns] for row in range(table.num_rows)]


def read_parquet_duckdb(path):
    cursor = duckdb_connection().execute("SELECT * FROM read_parquet(%s)" % literal(path))
    names = [description[0] for description in cursor.description]
    return names, [[render(value) for value in row] for row in cursor.fetchall()]


def read_xlsx(path):
    import openpyxl

    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    rows = [[render(cell) for cell in row] for row in workbook.worksheets[0].iter_rows(values_only=True)]
    workbook.close()
    return rows[0], rows[1:]


def instant(text):
    """The UTC instant an ISO 8601 or SQL timestamp names; naive times count as UTC. None for any other text."""
    if len(text) < 19 or text[4] != "-" or text[10] not in "T ":
        return None
    candidate = text.replace(" ", "T", 1)
    candidate = candidate[:-1] + "+00:00" if candidate.endswith("Z") else candidate
    if len(candidate) > 3 and candidate[-3] in "+-" and candidate[-3:].isdigit():
        candidate += ":00"
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        return None
    return parsed.astimezone(timezone.utc) if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def same(got, expected):
    """Equal as text, or the same instant (a timestamp is a value, not a spelling), or the same boolean (TRUE as a spreadsheet writes it)."""
    if got == expected:
        return True
    if {got.lower(), expected.lower()} <= {"true", "false"}:
        return got.lower() == expected.lower()
    a, b = instant(got), instant(expected)
    return a is not None and a == b


def score(header, rows, truth):
    """Cells of the truth that the output does not reproduce, a missing or extra row or column counting in full."""
    truth_header, truth_rows = truth
    width = len(truth_header)
    mismatches = 0
    first = None
    if header != truth_header:
        mismatches += width
        first = "header %r, expected %r" % (header, truth_header)
    for index, expected in enumerate(truth_rows):
        got = rows[index] if index < len(rows) else None
        if got is None:
            mismatches += width
            first = first or "row %d is missing" % index
            continue
        for column in range(width):
            value = got[column] if column < len(got) else MISSING
            if not same(value, expected[column]):
                mismatches += 1
                first = first or "row %d column %s: expected %r, got %r" % (index, truth_header[column], expected[column], value)
    if len(rows) > len(truth_rows):
        mismatches += (len(rows) - len(truth_rows)) * width
        first = first or "%d rows too many" % (len(rows) - len(truth_rows))
    return {"cells": len(truth_rows) * width, "mismatches": mismatches, "first": first}


@op("data.check")
def data_check(args):
    truth = read_truth(args["truth"])
    kind, path = args["kind"], args["file"]
    if kind == "json":
        return {"readers": {"json": score(*read_json_output(path, truth[0]), truth)}}
    if kind == "csv":
        return {"readers": {"csv": score(*read_csv_text(path), truth)}}
    if kind == "parquet":
        return {"readers": {"pyarrow": score(*read_parquet_pyarrow(path), truth), "duckdb": score(*read_parquet_duckdb(path), truth)}}
    if kind == "xlsx":
        return {"readers": {"openpyxl": score(*read_xlsx(path), truth)}}
    raise ValueError("unknown output kind " + kind)


# --------------------------------------------------------------------------------------------------------------------
# Fonts: oracles
# --------------------------------------------------------------------------------------------------------------------

def table_bytes(font, tag):
    """The bytes of a table; head.checkSumAdjustment (bytes 8 to 12) is a function of the whole file, so it differs between writers."""
    data = bytearray(font.reader[tag])
    if tag == "head":
        data[8:12] = b"\x00\x00\x00\x00"
    return bytes(data)


@op("font.compare")
def font_compare(args):
    """Tables of `file` that differ from those of `expected`, byte for byte (WOFF is read transparently by fontTools)."""
    from fontTools.ttLib import TTFont

    got = TTFont(args["file"], lazy=True)
    expected = TTFont(args["expected"], lazy=True)
    got_tags, expected_tags = set(got.reader.keys()), set(expected.reader.keys())
    differing = sorted(got_tags ^ expected_tags)
    differing += sorted(tag for tag in got_tags & expected_tags if table_bytes(got, tag) != table_bytes(expected, tag))
    return {"tables": len(expected_tags), "differing": differing}


def glyph_statistics(font):
    """Area, centroid and second moments of every glyph outline, in em: exact integrals over the curves, whichever degree they are."""
    from fontTools.pens.statisticsPen import StatisticsPen

    glyph_set = font.getGlyphSet()
    em = font["head"].unitsPerEm
    result = []
    for name in font.getGlyphOrder():
        pen = StatisticsPen(glyph_set)
        glyph_set[name].draw(pen)
        if not pen.area:
            result.append(None)
            continue
        result.append((abs(pen.area) / (em * em), pen.meanX / em, pen.meanY / em, pen.varianceX / (em * em), pen.varianceY / (em * em)))
    return result


def outline_differs(got, expected, tolerance):
    if got is None or expected is None:
        return (got is None) != (expected is None)
    area, mean_x, mean_y, variance_x, variance_y = got
    e_area, e_mean_x, e_mean_y, e_variance_x, e_variance_y = expected
    return (
        abs(area - e_area) > tolerance["area"] * e_area
        or abs(mean_x - e_mean_x) > tolerance["centroid"]
        or abs(mean_y - e_mean_y) > tolerance["centroid"]
        or abs(variance_x - e_variance_x) > tolerance["moment"] * e_variance_x
        or abs(variance_y - e_variance_y) > tolerance["moment"] * e_variance_y
    )


@op("font.validate")
def font_validate(args):
    """Spec bar for an outline conversion: the font opens, keeps the glyph count, the character map, the advances and the required tables, and every outline keeps its shape."""
    from fontTools.ttLib import TTFont

    out, source = TTFont(args["file"]), TTFont(args["expected"])
    failures = []

    def by_glyph_id(font):
        """Glyph names are a spelling of the writer; the identity of a glyph is its index."""
        order = font.getGlyphOrder()
        index = {name: position for position, name in enumerate(order)}
        return len(order), {code: index[name] for code, name in font.getBestCmap().items()}, [font["hmtx"][name][0] for name in order]

    ours_count, ours_cmap, ours_advances = by_glyph_id(out)
    source_count, source_cmap, source_advances = by_glyph_id(source)
    if ours_count != source_count:
        failures.append("glyph count")
    if ours_cmap != source_cmap:
        failures.append("character map")
    if ours_advances != source_advances:
        failures.append("advance widths")
    if out["head"].unitsPerEm != source["head"].unitsPerEm:
        failures.append("units per em")
    if (out["hhea"].ascent, out["hhea"].descent, out["hhea"].lineGap) != (source["hhea"].ascent, source["hhea"].descent, source["hhea"].lineGap):
        failures.append("vertical metrics")
    for tag in out.reader.keys():
        out.reader[tag]  # every table is readable
    for tag in ("name", "OS/2", "post", "cmap", "head", "hhea", "hmtx", "maxp"):
        if tag not in out:
            failures.append("missing table " + tag)
    ours_outlines, source_outlines = glyph_statistics(out), glyph_statistics(source)
    mismatched = sum(1 for got, expected in zip(ours_outlines, source_outlines) if outline_differs(got, expected, args["tolerance"]))
    return {"failures": failures, "glyphs": len(source_outlines), "mismatchedGlyphs": mismatched}


# --------------------------------------------------------------------------------------------------------------------
# CAD: the stroke geometry and the text of a DXF drawing, read by ezdxf
# --------------------------------------------------------------------------------------------------------------------

STROKE_TYPES = {"LINE", "ARC", "CIRCLE", "ELLIPSE", "SPLINE", "LWPOLYLINE", "POLYLINE"}
TEXT_TYPES = {"TEXT", "MTEXT"}
FLATTEN_SHARE = 1 / 4000
MAX_INSERT_DEPTH = 8


def visible(doc, entity):
    """False for an entity that sits on a layer that is off or frozen, or that is itself invisible."""
    if entity.dxf.hasattr("invisible") and entity.dxf.invisible:
        return False
    layer = doc.layers.get(entity.dxf.layer) if doc.layers.has_entry(entity.dxf.layer) else None
    return layer is None or not (layer.is_off() or layer.is_frozen())


def cad_entities(doc, space, depth=0):
    """The stroke and text entities of a layout, blocks inserted (arrays and nested blocks too) and dimensions exploded."""
    for entity in space:
        kind = entity.dxftype()
        if not visible(doc, entity):
            continue
        if kind in STROKE_TYPES or kind in TEXT_TYPES:
            yield entity
            if kind == "MTEXT" and getattr(entity, "has_columns", False) and entity.columns and entity.columns.linked_columns:
                col_width = getattr(entity.columns, "width", 0.0)
                for col in entity.columns.linked_columns:
                    if visible(doc, col):
                        if col_width > 0:
                            col.dxf.width = col_width
                        yield col
        elif kind in ("INSERT", "DIMENSION") and depth < MAX_INSERT_DEPTH:
            try:
                parts = list(entity.virtual_entities())
            except Exception:  # noqa: BLE001 - a block the library cannot expand adds nothing to the truth
                continue
            yield from cad_entities(doc, parts, depth + 1)


@op("cad.truth")
def cad_truth(args):
    import ezdxf
    from ezdxf import bbox, path as ezpath

    # The library's recovery mode reads what CAD programs read: a drawing that misses a required group (a hand-written or generated
    # file) is repaired on the way in, and a valid one comes out the same.
    from ezdxf import recover

    doc, _auditor = recover.readfile(args["file"])
    entities = list(cad_entities(doc, doc.modelspace()))
    strokes_of = [entity for entity in entities if entity.dxftype() in STROKE_TYPES]
    clamped_strokes, unclamped_polylines = [], []
    for entity in strokes_of:
        if entity.dxftype() == "SPLINE":
            try:
                bs = entity.construction_tool()
                k = bs.knots()
                if len(k) > bs.count and (k[bs.degree] > k[0] or k[bs.count] < k[-1]):
                    steps = max(16, (bs.count - bs.degree) * 16)
                    t0, t1 = k[bs.degree], k[bs.count]
                    pts = [[round(p.x, 6), round(p.y, 6)] for p in (bs.point(t0 + (t1 - t0) * i / steps) for i in range(steps + 1))]
                    if len(pts) >= 2:
                        unclamped_polylines.append(pts)
                    continue
            except Exception:  # noqa: BLE001 - fall back to make_path if construction_tool fails
                pass
        clamped_strokes.append(entity)
    extent = bbox.extents(clamped_strokes, fast=True)
    for poly in unclamped_polylines:
        extent.extend(poly)
    if not extent.has_data:
        raise ValueError("the drawing has no strokes")
    size = max(extent.size.x, extent.size.y)
    distance = max(size * FLATTEN_SHARE, 1e-9)
    strokes, text_boxes, words = list(unclamped_polylines), [], []
    for entity in clamped_strokes:
        try:
            drawn = ezpath.make_path(entity)
        except Exception:  # noqa: BLE001 - an entity the library cannot turn into a path is not in the truth
            continue
        for sub in drawn.sub_paths():
            points = [(round(point.x, 6), round(point.y, 6)) for point in sub.flattening(distance, segments=4)]
            if len(points) >= 2:
                strokes.append([list(point) for point in points])
    for entity in entities:
        if entity.dxftype() not in TEXT_TYPES:
            continue
        text = entity.dxf.text if entity.dxftype() == "TEXT" else entity.plain_text()
        words.append(text)
        try:
            box = bbox.extents([entity], fast=True)
            if box.has_data:
                text_boxes.append([box.extmin.x, box.extmin.y, box.extmax.x, box.extmax.y])
        except Exception:  # noqa: BLE001 - the size of a text is an estimate; without it the text is not excluded from precision
            continue
    return {"strokes": strokes, "textBoxes": text_boxes, "words": " ".join(words).split()}


# --------------------------------------------------------------------------------------------------------------------
# Office: the text of the 97-2003 binary formats, read from the file format and not from a converter
# --------------------------------------------------------------------------------------------------------------------

import struct

DOC_FIB_FLAGS_OFFSET = 0x0A
DOC_FIB_CCP_TEXT_OFFSET = 0x4C
DOC_FIB_FC_CLX_OFFSET = 0x1A2
DOC_FIELD_BEGIN, DOC_FIELD_SEPARATOR, DOC_FIELD_END = "\x13", "\x14", "\x15"


def doc_text(ole):
    """The main text of a Word 97-2003 file: the pieces of its piece table in order, field codes left out."""
    word = ole.openstream("WordDocument").read()
    if struct.unpack_from("<H", word, 0)[0] != 0xA5EC:
        raise ValueError("not a Word binary file")
    flags = struct.unpack_from("<H", word, DOC_FIB_FLAGS_OFFSET)[0]
    table = ole.openstream("1Table" if flags & 0x0200 else "0Table").read()
    characters = struct.unpack_from("<I", word, DOC_FIB_CCP_TEXT_OFFSET)[0]
    fc_clx, lcb_clx = struct.unpack_from("<II", word, DOC_FIB_FC_CLX_OFFSET)
    clx = table[fc_clx : fc_clx + lcb_clx]
    position = 0
    while clx[position] == 1:  # a Prc: skip it
        position += 3 + struct.unpack_from("<H", clx, position + 1)[0]
    if clx[position] != 2:
        raise ValueError("no piece table")
    length = struct.unpack_from("<I", clx, position + 1)[0]
    plc = clx[position + 5 : position + 5 + length]
    pieces = (length - 4) // 12
    cps = struct.unpack_from("<%dI" % (pieces + 1), plc, 0)
    out = []
    for index in range(pieces):
        fc = struct.unpack_from("<I", plc, 4 * (pieces + 1) + 8 * index + 2)[0]
        count = cps[index + 1] - cps[index]
        if fc & 0x40000000:
            start = (fc & 0x3FFFFFFF) // 2
            out.append(word[start : start + count].decode("cp1252", "replace"))
        else:
            out.append(word[fc : fc + 2 * count].decode("utf-16-le", "replace"))
    text = "".join(out)[:characters]
    cleaned, depth, in_code = [], 0, False
    for character in text:
        if character == DOC_FIELD_BEGIN:
            depth += 1
            in_code = True
        elif character == DOC_FIELD_SEPARATOR:
            in_code = False
        elif character == DOC_FIELD_END:
            depth = max(0, depth - 1)
            in_code = False
        elif not in_code:
            cleaned.append(character if character >= " " else " ")
    return "".join(cleaned)


def ppt_text(ole):
    """
    The text of the slides of a PowerPoint 97-2003 file. Text atoms sit twice in a file written by PowerPoint (in the outline list of
    the slides and in the text boxes of the slides); the text boxes are the text a slide shows, and the outline list stands in
    for them when a writer left them out. Masters and notes are not slides.
    """
    stream = ole.openstream("PowerPoint Document").read()
    in_boxes, in_list = [], []

    def walk(start, end, place):
        position = start
        while position + 8 <= end:
            header, kind, size = struct.unpack_from("<HHI", stream, position)
            body = position + 8
            version, instance = header & 0xF, header >> 4
            if version == 0xF:
                if kind == 0x03EE:  # a Slide
                    walk(body, min(end, body + size), "boxes")
                elif kind == 0x0FF0 and instance == 0:  # the SlideListWithText of the slides
                    walk(body, min(end, body + size), "list")
                elif kind in (0x03F8, 0x03F0, 0x0FF0, 0x0FF1):  # a master, a notes page, or the other lists
                    pass
                else:
                    walk(body, min(end, body + size), place)
            elif place is not None and kind in (0x0FA0, 0x0FA8):
                text = stream[body : body + size].decode("utf-16-le" if kind == 0x0FA0 else "cp1252", "replace")
                (in_boxes if place == "boxes" else in_list).append(text)
            position = body + size

    walk(0, len(stream), None)
    return "\n".join(in_boxes or in_list).replace("\r", "\n").replace("\x0b", " ")


def xls_text(path):
    """The text cells of every sheet of an Excel 97-2003 file, as xlrd reads them (numbers are not words)."""
    import xlrd

    book = xlrd.open_workbook(path, on_demand=True)
    out = []
    for sheet in book.sheets():
        for row in range(sheet.nrows):
            out.extend(str(value) for value in sheet.row_values(row) if isinstance(value, str))
    return "\n".join(out)


@op("office.text")
def office_text(args):
    import olefile

    kind, path = args["format"], args["file"]
    if kind == "xls":
        return {"text": xls_text(path)}
    ole = olefile.OleFileIO(path)
    try:
        return {"text": doc_text(ole) if kind == "doc" else ppt_text(ole)}
    finally:
        ole.close()


def main():
    for line in sys.stdin:
        request = json.loads(line)
        try:
            result = {"id": request["id"], "ok": True, "result": OPS[request["op"]](request)}
        except Exception as error:  # noqa: BLE001 - the client reports it with the request that caused it
            result = {"id": request["id"], "ok": False, "error": "%s: %s" % (type(error).__name__, error)}
        sys.stdout.write(json.dumps(result) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
