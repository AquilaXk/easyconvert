"""Hand-assembled uncompressed CHM (ITSF v3, one PMGL listing chunk, content section 0 only)."""
import struct, uuid

CHUNK = 0x1000
DENSITY = 2
FILES = [
    ('/hello.txt', open('src/hello.txt', 'rb').read()),
    ('/dir/nested.txt', open('src/dir/nested.txt', 'rb').read()),
    ('/dir/data.bin', open('src/dir/data.bin', 'rb').read()),
]


def encint(n):
    out = [n & 0x7F]
    n >>= 7
    while n:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    return bytes(reversed(out))


content = b''
entries = []
def namelist(names):
    body = b''.join(struct.pack('<H', len(n)) + n.encode('utf-16-le') + b'\0\0' for n in names)
    return struct.pack('<HH', (len(body) + 4) // 2, len(names)) + body
NL = namelist(['Uncompressed'])
entries.append(('::DataSpace/NameList', len(content), len(NL)))
content += NL
for name, data in FILES:
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
chunk = chunk.ljust(CHUNK - len(quickref), b'\0') + quickref
assert len(chunk) == CHUNK

lang = 0x409
itsp = b'ITSP' + struct.pack('<IIIIIIiIIiII', 1, 0x54, 10, CHUNK, DENSITY, 1, -1, 0, 0, -1, 1, lang)
itsp += uuid.UUID('5D02926A-212E-11D0-9DF9-00A0C922E6EC').bytes_le
itsp += struct.pack('<Iiii', 0x54, -1, -1, -1)
assert len(itsp) == 0x54, len(itsp)

ITSF_LEN = 0x60
SEC0_LEN = 0x18
sec1_off = ITSF_LEN + SEC0_LEN
sec1_len = len(itsp) + CHUNK
content_off = sec1_off + sec1_len
total = content_off + len(content)

itsf = b'ITSF' + struct.pack('<IIIII', 3, ITSF_LEN, 1, 0x5E8B7C40, lang)
itsf += uuid.UUID('7C01FD10-7BAA-11D0-9E0C-00A0C922E6EC').bytes_le
itsf += uuid.UUID('7C01FD11-7BAA-11D0-9E0C-00A0C922E6EC').bytes_le
itsf += struct.pack('<QQQQQ', ITSF_LEN, SEC0_LEN, sec1_off, sec1_len, content_off)
assert len(itsf) == ITSF_LEN, len(itsf)
sec0 = struct.pack('<IIQII', 0x1FE, 0, total, 0, 0)
assert len(sec0) == SEC0_LEN
open('out/probe.chm', 'wb').write(itsf + sec0 + itsp + chunk + content)
