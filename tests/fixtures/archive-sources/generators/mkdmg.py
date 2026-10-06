"""Wrap an Apple-partitioned disk image (out/apm.img) in a UDIF (.dmg) with zlib chunks."""
import base64, struct, zlib

SECTOR = 512
CHUNK_SECTORS = 256
HFS_START = 64
RUN_ZLIB = 0x80000005
RUN_END = 0xFFFFFFFF

disk = open('out/apm.img', 'rb').read()
total_sectors = len(disk) // SECTOR

data_fork = bytearray()
blkx = []
mish_crcs = []


def make_mish(first, count, name, ident):
    global data_fork
    chunks = []
    mish_data_offset = len(data_fork)
    for start in range(first, first + count, CHUNK_SECTORS):
        n = min(CHUNK_SECTORS, first + count - start)
        raw = disk[start * SECTOR:(start + n) * SECTOR]
        comp = zlib.compress(raw, 9)
        chunks.append((RUN_ZLIB, start - first, n, len(data_fork), len(comp)))
        data_fork += comp
    chunks.append((RUN_END, count, 0, len(data_fork), 0))
    header = b'mish' + struct.pack('>IQQQII24x', 1, first, count, 0, CHUNK_SECTORS, ident)
    crc = zlib.crc32(disk[first * SECTOR:(first + count) * SECTOR]) & 0xFFFFFFFF
    mish_crcs.append(crc)
    header += struct.pack('>II', 2, 32) + struct.pack('>I', crc).ljust(128, b'\0')  # CRC32 of the partition
    header += struct.pack('>I', len(chunks))
    body = b''.join(struct.pack('>IIQQQQ', t, 0, s, c, o, l) for t, s, c, o, l in chunks)
    blob = header + body
    assert len(header) == 204, len(header)
    blkx.append((name, ident, blob))


make_mish(0, HFS_START, 'Apple partition map (Apple_partition_map : 1)', 0)
make_mish(HFS_START, total_sectors - HFS_START, 'disk image (Apple_HFS : 2)', 1)

entries = ''
for name, ident, blob in blkx:
    entries += (
        '<dict><key>Attributes</key><string>0x0050</string><key>CFName</key><string>%s</string>'
        '<key>Data</key><data>%s</data><key>ID</key><string>%d</string><key>Name</key><string>%s</string></dict>'
        % (name, base64.b64encode(blob).decode(), ident, name)
    )
plist = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    '<plist version="1.0"><dict><key>resource-fork</key><dict><key>blkx</key><array>%s</array></dict></dict></plist>\n'
    % entries
).encode()

xml_offset = len(data_fork)
koly = b'koly' + struct.pack('>III', 4, 512, 1)
koly += struct.pack('>QQQQQ', 0, 0, len(data_fork), 0, 0)
koly += struct.pack('>II', 1, 1) + b'\x11' * 16
koly += struct.pack('>II', 2, 32) + b'\0' * 128
koly += struct.pack('>QQ', xml_offset, len(plist)) + b'\0' * 120
master = zlib.crc32(b''.join(struct.pack('>I', c) for c in mish_crcs)) & 0xFFFFFFFF
koly += struct.pack('>II', 2, 32) + struct.pack('>I', master).ljust(128, b'\0')
koly += struct.pack('>IQ', 1, total_sectors) + b'\0' * 12
assert len(koly) == 512, len(koly)
open('out/probe.dmg', 'wb').write(bytes(data_fork) + plist + koly)
