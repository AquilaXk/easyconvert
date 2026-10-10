"""Reference text and table extraction for HWP 5.0 files.

Written from the Hancom "Hangul Document File Format 5.0" specification and the olefile package
(OLE2 container access); it shares no code with the converter. The *.reference.json goldens next to
this file are its output:

    python3 reference-extract.py blank.hwp > blank.reference.json

Output: version, flags, the number of BodyText sections, every non-blank paragraph in file order with
its record level, and every table as a rows x cols grid of cell texts (a cell holds the texts of the
paragraphs inside it, joined with a single space). `body` lists the document in reading order: the paragraphs
outside tables, headers, footers, footnotes, endnotes and comments, with each top-level table at the place
its control stands. `headerFooter` holds the paragraphs of headers and footers; `notes` those of footnotes and
endnotes. `captions` holds the paragraphs of table captions, which are neither cells nor body text.
`pictures` lists the BinData entries the picture records name, in file order, with the SHA-256 of
each (inflated) stream. Every table also lists the column and row span of each cell as `spans`.
"""
import hashlib
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
TAG_PICTURE = 85
TAG_BIN_DATA = 18
PICTURE_BIN_ITEM_OFFSET = 71
# Control ids (stored reversed) whose paragraphs are not body text.
SPECIAL_CONTROLS = {b'daeh': 'headerFooter', b'toof': 'headerFooter', b'  nf': 'notes', b'  ne': 'notes', b'tmct': 'comment'}
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
    body = []
    header_footer = []
    notes = []
    captions = []
    pictures = []
    bin_entries = []
    doc_info = ole.openstream('DocInfo').read()
    if compressed:
        doc_info = zlib.decompress(doc_info, -15)
    for tag, level, payload in records(doc_info):
        if tag == TAG_BIN_DATA:
            attributes, bin_id, ext_len = struct.unpack_from('<HHH', payload, 0)
            bin_entries.append({'id': bin_id, 'ext': payload[6:6 + ext_len * 2].decode('utf-16-le'), 'embedded': (attributes & 0xF) == 1, 'mode': (attributes >> 4) & 3})
    for entry in sections:
        data = ole.openstream(entry).read()
        if compressed:
            data = zlib.decompress(data, -15)
        open_tables = []  # innermost last: {'level', 'rows', 'cols', 'cells': {(r, c): [texts]}, 'cell': (r, c) or None}
        special = []  # open header/footer/note/comment controls: (level, bucket)
        for tag, level, payload in records(data):
            while special and level <= special[-1][0]:
                special.pop()
            while open_tables and level <= open_tables[-1]['level']:
                done = open_tables.pop()
                grid = [[' '.join(done['cells'].get((r, c), [])) for c in range(done['cols'])] for r in range(done['rows'])]
                if open_tables and open_tables[-1]['cell'] is not None:
                    open_tables[-1]['cells'][open_tables[-1]['cell']].extend(cell for row in grid for cell in row if cell)
                else:
                    if done['slot'] is not None:
                        done['slot']['index'] = len(tables)
                    tables.append({'rows': done['rows'], 'cols': done['cols'], 'cells': grid, 'spans': done['spans']})
            if tag == TAG_CTRL_HEADER and payload[:4] in SPECIAL_CONTROLS:
                special.append((level, SPECIAL_CONTROLS[payload[:4]]))
            if tag == TAG_CTRL_HEADER and payload[:4] == TABLE_CONTROL_ID:
                slot = None
                if not open_tables and not special:
                    slot = {'kind': 'table', 'index': None}
                    body.append(slot)
                open_tables.append({'level': level, 'rows': 0, 'cols': 0, 'cells': {}, 'cell': None, 'slot': slot, 'spans': []})
            if tag == TAG_PICTURE and len(payload) >= PICTURE_BIN_ITEM_OFFSET + 2:
                (item,) = struct.unpack_from('<H', payload, PICTURE_BIN_ITEM_OFFSET)
                entry = bin_entries[item - 1]
                name = 'BIN%04X.%s' % (entry['id'], entry['ext'])
                raw = ole.openstream(['BinData', name]).read()
                if entry['mode'] == 1 or (entry['mode'] == 0 and compressed):
                    raw = zlib.decompress(raw, -15)
                pictures.append({'item': item, 'stream': name, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)})
            elif tag == TAG_TABLE and open_tables:
                open_tables[-1]['rows'], open_tables[-1]['cols'] = struct.unpack_from('<HH', payload, 4)
            elif tag == TAG_LIST_HEADER and open_tables and open_tables[-1]['rows'] > 0 and level == open_tables[-1]['level'] + 1:
                # A list header before the TABLE record is the table's caption, whose paragraphs are not cells.
                col, row = struct.unpack_from('<HH', payload, 8)
                open_tables[-1]['cell'] = (row, col)
                open_tables[-1]['cells'].setdefault((row, col), [])
                col_span, row_span = struct.unpack_from('<HH', payload, 12)
                open_tables[-1]['spans'].append({'row': row, 'col': col, 'colSpan': col_span, 'rowSpan': row_span})
            elif tag == TAG_PARA_TEXT:
                text = para_text(payload).strip()
                if not text:
                    continue
                if open_tables and open_tables[-1]['cell'] is not None:
                    open_tables[-1]['cells'][open_tables[-1]['cell']].append(text)
                else:
                    paragraphs.append({'level': level, 'text': text})
                    bucket = special[-1][1] if special else 'body'
                    if open_tables:
                        captions.append(text)
                    elif bucket == 'body':
                        body.append({'kind': 'paragraph', 'text': text})
                    elif bucket == 'headerFooter':
                        header_footer.append(text)
                    elif bucket == 'notes':
                        notes.append(text)
        while open_tables:
            done = open_tables.pop()
            grid = [[' '.join(done['cells'].get((r, c), [])) for c in range(done['cols'])] for r in range(done['rows'])]
            if done['slot'] is not None:
                done['slot']['index'] = len(tables)
            tables.append({'rows': done['rows'], 'cols': done['cols'], 'cells': grid, 'spans': done['spans']})
    print(json.dumps({
        'version': '%d.%d.%d.%d' % (version >> 24 & 255, version >> 16 & 255, version >> 8 & 255, version & 255),
        'compressed': compressed,
        'encrypted': bool(flags & 2),
        'distributed': bool(flags & 4),
        'sections': len(sections),
        'paragraphs': paragraphs,
        'tables': tables,
        'body': body,
        'headerFooter': header_footer,
        'notes': notes,
        'captions': captions,
        'pictures': pictures,
    }, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main(sys.argv[1])
