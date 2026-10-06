"""Wrap part.img (HFS+) in an Apple partition map so the hfsplus tools can write to it."""
import struct

SECTOR = 512
HFS_START = 64
part = open('out/hfs.img', 'rb').read()
nblocks_part = len(part) // SECTOR
total = HFS_START + nblocks_part


def entry(index, start, count, name, ptype, status):
    return (
        struct.pack('>2sHIII', b'PM', 0, 2, start, count)
        + name.encode().ljust(32, b'\0')
        + ptype.encode().ljust(32, b'\0')
        + struct.pack('>III', 0, count, status)
    ).ljust(SECTOR, b'\0')


ddm = struct.pack('>2sHIIHHHH', b'ER', SECTOR, total, 0, 0, 0, 0, 0).ljust(SECTOR, b'\0')
disk = bytearray(total * SECTOR)
disk[0:SECTOR] = ddm
disk[SECTOR:2 * SECTOR] = entry(1, 1, 63, 'Apple', 'Apple_partition_map', 0x3)
disk[2 * SECTOR:3 * SECTOR] = entry(2, HFS_START, nblocks_part, 'disk image', 'Apple_HFS', 0x40000033)
disk[HFS_START * SECTOR:] = part
open('out/apm.img', 'wb').write(disk)
