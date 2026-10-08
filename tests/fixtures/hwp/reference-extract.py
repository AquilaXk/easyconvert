"""Reference text and table extraction for HWP 5.0 files.

Written from the Hancom "Hangul Document File Format 5.0" specification and the olefile package
(OLE2 container access); it shares no code with the converter. The *.reference.json goldens next to
this file are its output:

    python3 reference-extract.py blank.hwp > blank.reference.json

Output: version, flags, the number of BodyText sections, every non-blank paragraph in file order with
its record level, and every table as a rows x cols grid of cell texts (a cell holds the texts of the
paragraphs inside it, joined with a single space).
"""
import json
import struct
import sys
import zlib

import olefile

TAG_PARA_TEXT = 67
TAG_CTRL_HEADER = 71
TAG_LIST_HEADER = 72
TAG_TABLE = 77
EXTENDED_SIZE = 0xFFF
TABLE_CONTROL_ID = b' lbt'
# Control characters that occupy 8 UTF-16 units: the code, six units of data, the code again.
EIGHT_UNIT_CONTROLS = {1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23}
TAB = 9
LINE_BREAK = 10
HYPHEN = 24
FIXED_SPACES = {30, 31}


def records(data):
    pos = 0
    while pos < len(data):
        (header,) = struct.unpack_from('<I', data, pos)
        pos += 4
        tag = header & 0x3FF
        level = (header >> 10) & 0x3FF
        size = header >> 20
        if size == EXTENDED_SIZE:
            (size,) = struct.unpack_from('<I', data, pos)
            pos += 4
        yield tag, level, data[pos:pos + size]
        pos += size


def para_text(payload):
    units = struct.unpack('<%dH' % (len(payload) // 2), payload[: len(payload) // 2 * 2])
    out = []
    i = 0
    while i < len(units):
        c = units[i]
        if c in EIGHT_UNIT_CONTROLS:
            if c == TAB:
                out.append('\t')
            i += 8
            continue
        if c == LINE_BREAK:
            out.append('\n')
        elif c == HYPHEN:
            out.append('-')
        elif c in FIXED_SPACES:
            out.append(' ')
        elif c >= 32:
            out.append(chr(c))
        i += 1
    return ''.join(out)


def main(path):
    ole = olefile.OleFileIO(path)
    header = ole.openstream('FileHeader').read()
    assert header[:17] == b'HWP Document File'
    (version,) = struct.unpack_from('<I', header, 32)
    (flags,) = struct.unpack_from('<I', header, 36)
    compressed = bool(flags & 1)
    sections = sorted(
        (e for e in ole.listdir() if len(e) == 2 and e[0] == 'BodyText' and e[1].startswith('Section')),
        key=lambda e: int(e[1][len('Section'):]),
    )
    paragraphs = []
    tables = []
    for entry in sections:
        data = ole.openstream(entry).read()
        if compressed:
            data = zlib.decompress(data, -15)
        open_tables = []  # innermost last: {'level', 'rows', 'cols', 'cells': {(r, c): [texts]}, 'cell': (r, c) or None}
        for tag, level, payload in records(data):
            while open_tables and level <= open_tables[-1]['level']:
                done = open_tables.pop()
                grid = [[' '.join(done['cells'].get((r, c), [])) for c in range(done['cols'])] for r in range(done['rows'])]
                if open_tables and open_tables[-1]['cell'] is not None:
                    open_tables[-1]['cells'][open_tables[-1]['cell']].extend(cell for row in grid for cell in row if cell)
                else:
                    tables.append({'rows': done['rows'], 'cols': done['cols'], 'cells': grid})
            if tag == TAG_CTRL_HEADER and payload[:4] == TABLE_CONTROL_ID:
                open_tables.append({'level': level, 'rows': 0, 'cols': 0, 'cells': {}, 'cell': None})
            elif tag == TAG_TABLE and open_tables:
                open_tables[-1]['rows'], open_tables[-1]['cols'] = struct.unpack_from('<HH', payload, 4)
            elif tag == TAG_LIST_HEADER and open_tables and open_tables[-1]['rows'] > 0 and level == open_tables[-1]['level'] + 1:
                # A list header before the TABLE record is the table's caption, whose paragraphs are not cells.
                col, row = struct.unpack_from('<HH', payload, 8)
                open_tables[-1]['cell'] = (row, col)
                open_tables[-1]['cells'].setdefault((row, col), [])
            elif tag == TAG_PARA_TEXT:
                text = para_text(payload).strip()
                if not text:
                    continue
                if open_tables and open_tables[-1]['cell'] is not None:
                    open_tables[-1]['cells'][open_tables[-1]['cell']].append(text)
                else:
                    paragraphs.append({'level': level, 'text': text})
        while open_tables:
            done = open_tables.pop()
            grid = [[' '.join(done['cells'].get((r, c), [])) for c in range(done['cols'])] for r in range(done['rows'])]
            tables.append({'rows': done['rows'], 'cols': done['cols'], 'cells': grid})
    print(json.dumps({
        'version': '%d.%d.%d.%d' % (version >> 24 & 255, version >> 16 & 255, version >> 8 & 255, version & 255),
        'compressed': compressed,
        'encrypted': bool(flags & 2),
        'distributed': bool(flags & 4),
        'sections': len(sections),
        'paragraphs': paragraphs,
        'tables': tables,
    }, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main(sys.argv[1])
