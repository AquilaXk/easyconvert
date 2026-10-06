/**
 * Minimal Compound File Binary writer for tests, authored from [MS-CFB]: 512-byte sectors, a
 * version 3 header, one directory sector chain and a FAT, with every stream held in regular sectors
 * (no mini stream). Streams are siblings under the root, linked through right-sibling ids.
 */

const SECTOR_SIZE = 512;
const DIRECTORY_ENTRY_SIZE = 128;
const ENTRIES_PER_SECTOR = SECTOR_SIZE / DIRECTORY_ENTRY_SIZE;
const FAT_ENTRIES_PER_SECTOR = SECTOR_SIZE / 4;
const HEADER_FAT_SLOTS = 109;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;
const ENTRY_TYPE_STREAM = 2;
const ENTRY_TYPE_ROOT = 5;
const MAX_NAME_UTF16_BYTES = 64;

export interface CfbStream {
  name: string;
  data: Buffer;
}

export function buildCompoundFile(streams: CfbStream[]): Buffer {
  const directorySectors = Math.ceil((streams.length + 1) / ENTRIES_PER_SECTOR);
  const sectorCounts = streams.map((s) => Math.max(1, Math.ceil(s.data.length / SECTOR_SIZE)));
  const dataSectors = sectorCounts.reduce((a, b) => a + b, 0);
  const usedBeforeFat = directorySectors + dataSectors;

  let fatSectors = 1;
  while (usedBeforeFat + fatSectors > fatSectors * FAT_ENTRIES_PER_SECTOR) fatSectors++;
  if (fatSectors > HEADER_FAT_SLOTS) throw new Error('compound file too large for a header-only FAT');

  const header = Buffer.alloc(SECTOR_SIZE);
  header.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  header.writeUInt16LE(0x003e, 24); // minor version
  header.writeUInt16LE(3, 26); // major version
  header.writeUInt16LE(0xfffe, 28); // little endian
  header.writeUInt16LE(9, 30); // 512-byte sectors
  header.writeUInt16LE(6, 32); // 64-byte mini sectors
  header.writeUInt32LE(0, 40); // directory sector count (v3: zero)
  header.writeUInt32LE(fatSectors, 44);
  header.writeUInt32LE(0, 48); // first directory sector
  header.writeUInt32LE(4096, 56); // mini stream cutoff
  header.writeUInt32LE(ENDOFCHAIN, 60); // no mini FAT
  header.writeUInt32LE(0, 64);
  header.writeUInt32LE(ENDOFCHAIN, 68); // no DIFAT
  header.writeUInt32LE(0, 72);
  header.fill(0xff, 76, 76 + HEADER_FAT_SLOTS * 4);
  for (let f = 0; f < fatSectors; f++) header.writeUInt32LE(usedBeforeFat + f, 76 + f * 4);

  const directory = Buffer.alloc(directorySectors * SECTOR_SIZE);
  const writeEntry = (index: number, name: string, type: number, start: number, size: number, child: number, right: number) => {
    const at = index * DIRECTORY_ENTRY_SIZE;
    const nameBytes = Buffer.from(name, 'utf16le');
    if (nameBytes.length + 2 > MAX_NAME_UTF16_BYTES) throw new Error(`stream name too long: ${name}`);
    nameBytes.copy(directory, at);
    directory.writeUInt16LE(nameBytes.length + 2, at + 64);
    directory.writeUInt8(type, at + 66);
    directory.writeUInt32LE(NOSTREAM, at + 68);
    directory.writeUInt32LE(right, at + 72);
    directory.writeUInt32LE(child, at + 76);
    directory.writeUInt32LE(start, at + 116);
    directory.writeUInt32LE(size, at + 120);
  };
  writeEntry(0, 'Root Entry', ENTRY_TYPE_ROOT, ENDOFCHAIN, 0, streams.length > 0 ? 1 : NOSTREAM, NOSTREAM);

  const fat = Buffer.alloc(fatSectors * SECTOR_SIZE, 0xff);
  for (let d = 0; d < directorySectors; d++) {
    fat.writeUInt32LE(d === directorySectors - 1 ? ENDOFCHAIN : d + 1, d * 4);
  }

  const dataChunks: Buffer[] = [];
  let nextSector = directorySectors;
  streams.forEach((stream, i) => {
    const count = sectorCounts[i];
    const padded = Buffer.alloc(count * SECTOR_SIZE);
    stream.data.copy(padded);
    dataChunks.push(padded);
    for (let s = 0; s < count; s++) {
      fat.writeUInt32LE(s === count - 1 ? ENDOFCHAIN : nextSector + s + 1, (nextSector + s) * 4);
    }
    const right = i === streams.length - 1 ? NOSTREAM : i + 2;
    writeEntry(i + 1, stream.name, ENTRY_TYPE_STREAM, nextSector, stream.data.length, NOSTREAM, right);
    nextSector += count;
  });
  for (let f = 0; f < fatSectors; f++) fat.writeUInt32LE(FATSECT, (usedBeforeFat + f) * 4);

  return Buffer.concat([header, directory, ...dataChunks, fat]);
}
