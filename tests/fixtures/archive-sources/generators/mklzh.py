"""Hand-written LZH (-lh0- stored, level 0 headers); verified with lhasa (`lha l`) and read by 7-Zip."""
import struct

FILES = [
    ('hello.txt', open('src/hello.txt', 'rb').read()),
    ('dir/nested.txt', open('src/dir/nested.txt', 'rb').read()),
    ('dir/data.bin', open('src/dir/data.bin', 'rb').read()),
]
DOS_TIME = (2024 - 1980) << 25 | 1 << 21 | 2 << 16 | 3 << 11 | 4 << 5 | 3


def crc16(data):
    crc = 0
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def level0(name, data):
    n = name.replace('/', '\\').encode()
    body = (
        b'-lh0-'
        + struct.pack('<II', len(data), len(data))
        + struct.pack('<I', DOS_TIME)
        + bytes([0x20, 0])
        + bytes([len(n)])
        + n
        + struct.pack('<H', crc16(data))
    )
    return bytes([len(body), sum(body) & 0xFF]) + body + data


open('out/level0.lzh', 'wb').write(b''.join(level0(n, d) for n, d in FILES) + b'\x00')
