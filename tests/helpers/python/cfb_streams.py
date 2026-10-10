"""Lists the entries of an OLE compound file (MS-CFB) using only the standard library: `cfb_streams.py FILE`
prints a JSON object with the entry names and the size of the stream named WordDocument, when there is one."""
import json
import struct
import sys

END_OF_CHAIN = 0xFFFFFFFE
FREE_SECTOR = 0xFFFFFFFF
HEADER_DIFAT_ENTRIES = 109
DIRECTORY_ENTRY_SIZE = 128


def main(path):
    with open(path, 'rb') as handle:
        data = handle.read()
    if data[:8] != bytes.fromhex('d0cf11e0a1b11ae1'):
        raise SystemExit('not an OLE compound file')
    sector_size = 1 << struct.unpack_from('<H', data, 0x1E)[0]
    fat_sector_count, first_directory = struct.unpack_from('<II', data, 0x2C)
    if fat_sector_count > HEADER_DIFAT_ENTRIES:
        raise SystemExit('files with a DIFAT chain are not supported')

    def sector(index):
        start = (index + 1) * sector_size
        return data[start:start + sector_size]

    difat = [value for value in struct.unpack_from('<%dI' % HEADER_DIFAT_ENTRIES, data, 0x4C) if value != FREE_SECTOR]
    fat = []
    for fat_sector in difat[:fat_sector_count]:
        fat.extend(struct.unpack('<%dI' % (sector_size // 4), sector(fat_sector)))

    directory = b''
    current = first_directory
    seen = set()
    while current != END_OF_CHAIN:
        if current in seen:
            raise SystemExit('directory chain loops')
        seen.add(current)
        directory += sector(current)
        current = fat[current]

    names = []
    word_document_size = None
    for offset in range(0, len(directory), DIRECTORY_ENTRY_SIZE):
        entry = directory[offset:offset + DIRECTORY_ENTRY_SIZE]
        name_length = struct.unpack_from('<H', entry, 0x40)[0]
        if name_length < 2:
            continue
        name = entry[:name_length - 2].decode('utf-16-le')
        names.append(name)
        if name == 'WordDocument':
            word_document_size = struct.unpack_from('<Q', entry, 0x78)[0]
    print(json.dumps({'names': names, 'wordDocumentSize': word_document_size}))


main(sys.argv[1])
