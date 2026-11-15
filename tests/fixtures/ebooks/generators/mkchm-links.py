"""Hand-assembled uncompressed CHM (ITSF v3, one PMGL listing chunk, content section 0 only; layout as generators/mkchm.py of archive-sources)
of a book whose first page links to /etc/hosts as a picture, a style sheet and a link, by a relative path, a file URL and an absolute path.
Run from tests/fixtures/ebooks with an out/ directory: python3 -I generators/mkchm-links.py"""
import struct, sys, uuid

CHUNK = 0x1000
DENSITY = 2
LCID = 0x409
HEAD = '/' + '../' * 12
INDEX = ('<html><head><title>Hostile links</title></head><body><h1>Chapter one</h1><p>The visible words of the book.</p>'
         '<p><img src="' + HEAD.lstrip('/') + 'etc/hosts"> <img src="file:///etc/hosts"> <img src="/etc/hosts">'
         '<a href="' + HEAD.lstrip('/') + 'etc/hosts">relative</a> <a href="file:///etc/hosts">file URL</a> <a href="/etc/hosts">absolute</a></p>'
         '<link rel="stylesheet" href="' + HEAD.lstrip('/') + 'etc/hosts"></body></html>')
PAGE2 = '<html><head><title>Chapter two</title></head><body><h1>Chapter two</h1><p>More visible words of the book.</p></body></html>'
HHC = ('<html><body><ul>'
       '<li><object type="text/sitemap"><param name="Name" value="Chapter one"><param name="Local" value="index.html"></object>'
       '<li><object type="text/sitemap"><param name="Name" value="Chapter two"><param name="Local" value="page2.html"></object>'
       '</ul></body></html>')


def encint(n):
    out = [n & 0x7F]
    n >>= 7
    while n:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    return bytes(reversed(out))


def system_file():
    def entry(code, data):
        return struct.pack('<HH', code, len(data)) + data
    return struct.pack('<I', 3) + entry(0, b'toc.hhc\0') + entry(2, b'index.html\0') + entry(3, b'Hostile links\0') + entry(4, struct.pack('<IIII', LCID, 0, 0, 0))


def build(files):
    content = b''
    entries = []
    def namelist(names):
        body = b''.join(struct.pack('<H', len(n)) + n.encode('utf-16-le') + b'\0\0' for n in names)
        return struct.pack('<HH', (len(body) + 4) // 2, len(names)) + body
    nl = namelist(['Uncompressed'])
    entries.append(('::DataSpace/NameList', len(content), len(nl)))
    content += nl
    for name, data in files:
        entries.append((name, len(content), len(data)))
        content += data
    entries.sort(key=lambda e: e[0].lower())
    raw = []
    for name, off, length in entries:
        n = name.encode()
        raw.append(encint(len(n)) + n + encint(0) + encint(off) + encint(length))
    body = b''.join(raw)
    quick_offsets = []
    pos = 0
    for i, r in enumerate(raw):
        if i % ((1 << DENSITY) + 1) == 0:
            quick_offsets.append(pos)
        pos += len(r)
    free = CHUNK - 20 - len(body)
    quickref = b''.join(struct.pack('<H', o) for o in reversed(quick_offsets)) + struct.pack('<H', len(raw))
    chunk = b'PMGL' + struct.pack('<IIii', free, 0, -1, -1) + body
    assert len(chunk) + len(quickref) <= CHUNK, len(chunk)
    chunk = chunk.ljust(CHUNK - len(quickref), b'\0') + quickref
    itsp = b'ITSP' + struct.pack('<IIIIIIiIIiII', 1, 0x54, 10, CHUNK, DENSITY, 1, -1, 0, 0, -1, 1, LCID)
    itsp += uuid.UUID('5D02926A-212E-11D0-9DF9-00A0C922E6EC').bytes_le
    itsp += struct.pack('<Iiii', 0x54, -1, -1, -1)
    ITSF_LEN, SEC0_LEN = 0x60, 0x18
    sec1_off = ITSF_LEN + SEC0_LEN
    sec1_len = len(itsp) + CHUNK
    content_off = sec1_off + sec1_len
    total = content_off + len(content)
    itsf = b'ITSF' + struct.pack('<IIIII', 3, ITSF_LEN, 1, 0x5E8B7C40, LCID)
    itsf += uuid.UUID('7C01FD10-7BAA-11D0-9E0C-00A0C922E6EC').bytes_le
    itsf += uuid.UUID('7C01FD11-7BAA-11D0-9E0C-00A0C922E6EC').bytes_le
    itsf += struct.pack('<QQQQQ', ITSF_LEN, SEC0_LEN, sec1_off, sec1_len, content_off)
    sec0 = struct.pack('<IIQII', 0x1FE, 0, total, 0, 0)
    return itsf + sec0 + itsp + chunk + content


plain = [('/#SYSTEM', system_file()), ('/toc.hhc', HHC.encode()), ('/index.html', INDEX.encode()), ('/page2.html', PAGE2.encode())]
open('out/hostile-links.chm', 'wb').write(build(plain))
