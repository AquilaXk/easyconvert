/**
 * Minimal Compound File Binary writer for tests, authored from [MS-CFB]: 512-byte sectors, a version 3
 * header, one directory sector chain, a FAT, and a mini stream for streams under the 4096-byte cutoff.
 * A stream name with slashes (`BodyText/Section0`) puts the stream in the storages it names. The
 * children of each storage are siblings linked through right-sibling ids.
 */

const SECTOR_SIZE = 512;
const MINI_SECTOR_SIZE = 64;
const MINI_STREAM_CUTOFF = 4096;
const DIRECTORY_ENTRY_SIZE = 128;
const ENTRIES_PER_SECTOR = SECTOR_SIZE / DIRECTORY_ENTRY_SIZE;
const FAT_ENTRIES_PER_SECTOR = SECTOR_SIZE / 4;
const HEADER_FAT_SLOTS = 109;
const ENDOFCHAIN = 0xfffffffe;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;
const ENTRY_TYPE_STORAGE = 1;
const ENTRY_TYPE_STREAM = 2;
const ENTRY_TYPE_ROOT = 5;
const MAX_NAME_UTF16_BYTES = 64;

export interface CfbStream {
  name: string;
  data: Buffer;
}

interface Entry {
  name: string;
  type: number;
  data?: Buffer;
  children: Entry[];
  start: number;
  size: number;
}

const sectorsFor = (bytes: number, sectorSize: number): number => Math.ceil(bytes / sectorSize);

export function buildCompoundFile(streams: CfbStream[]): Buffer {
  const root: Entry = { name: 'Root Entry', type: ENTRY_TYPE_ROOT, children: [], start: ENDOFCHAIN, size: 0 };
  for (const stream of streams) {
    const parts = stream.name.split('/');
    let parent = root;
    for (const storage of parts.slice(0, -1)) {
      let next = parent.children.find((child) => child.type === ENTRY_TYPE_STORAGE && child.name === storage);
      if (!next) {
        next = { name: storage, type: ENTRY_TYPE_STORAGE, children: [], start: 0, size: 0 };
        parent.children.push(next);
      }
      parent = next;
    }
    parent.children.push({ name: parts[parts.length - 1], type: ENTRY_TYPE_STREAM, data: stream.data, children: [], start: ENDOFCHAIN, size: stream.data.length });
  }

  // Directory order: the root, then every entry as it is reached breadth first.
  const entries: Entry[] = [root];
  for (let i = 0; i < entries.length; i++) entries.push(...entries[i].children);

  const small = entries.filter((e) => e.type === ENTRY_TYPE_STREAM && e.size > 0 && e.size < MINI_STREAM_CUTOFF);
  const large = entries.filter((e) => e.type === ENTRY_TYPE_STREAM && e.size >= MINI_STREAM_CUTOFF);
  const miniSectors = small.reduce((sum, e) => sum + sectorsFor(e.size, MINI_SECTOR_SIZE), 0);
  const miniStream = Buffer.alloc(miniSectors * MINI_SECTOR_SIZE);
  const miniFat = Buffer.alloc(sectorsFor(miniSectors * 4, SECTOR_SIZE) * SECTOR_SIZE, 0xff);
  let miniNext = 0;
  for (const e of small) {
    const count = sectorsFor(e.size, MINI_SECTOR_SIZE);
    e.start = miniNext;
    (e.data as Buffer).copy(miniStream, miniNext * MINI_SECTOR_SIZE);
    for (let s = 0; s < count; s++) miniFat.writeUInt32LE(s === count - 1 ? ENDOFCHAIN : miniNext + s + 1, (miniNext + s) * 4);
    miniNext += count;
  }

  const directorySectors = sectorsFor(entries.length, ENTRIES_PER_SECTOR);
  const miniFatSectors = miniFat.length / SECTOR_SIZE;
  const miniStreamSectors = sectorsFor(miniStream.length, SECTOR_SIZE);
  const largeCounts = large.map((e) => sectorsFor(e.size, SECTOR_SIZE));
  const usedBeforeFat = directorySectors + miniFatSectors + miniStreamSectors + largeCounts.reduce((a, b) => a + b, 0);

  let fatSectors = 1;
  while (usedBeforeFat + fatSectors > fatSectors * FAT_ENTRIES_PER_SECTOR) fatSectors++;
  if (fatSectors > HEADER_FAT_SLOTS) throw new Error('compound file too large for a header-only FAT');

  const fat = Buffer.alloc(fatSectors * SECTOR_SIZE, 0xff);
  const chain = (first: number, count: number): void => {
    for (let s = 0; s < count; s++) fat.writeUInt32LE(s === count - 1 ? ENDOFCHAIN : first + s + 1, (first + s) * 4);
  };
  let next = 0;
  chain(next, directorySectors);
  next += directorySectors;
  const firstMiniFat = miniFatSectors > 0 ? next : ENDOFCHAIN;
  chain(next, miniFatSectors);
  next += miniFatSectors;
  const firstMiniStream = miniStreamSectors > 0 ? next : ENDOFCHAIN;
  chain(next, miniStreamSectors);
  next += miniStreamSectors;
  const dataChunks: Buffer[] = [];
  large.forEach((e, i) => {
    e.start = next;
    chain(next, largeCounts[i]);
    const padded = Buffer.alloc(largeCounts[i] * SECTOR_SIZE);
    (e.data as Buffer).copy(padded);
    dataChunks.push(padded);
    next += largeCounts[i];
  });
  for (let f = 0; f < fatSectors; f++) fat.writeUInt32LE(FATSECT, (usedBeforeFat + f) * 4);
  root.start = firstMiniStream;
  root.size = miniStream.length;

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
  header.writeUInt32LE(MINI_STREAM_CUTOFF, 56);
  header.writeUInt32LE(firstMiniFat, 60);
  header.writeUInt32LE(miniFatSectors, 64);
  header.writeUInt32LE(ENDOFCHAIN, 68); // no DIFAT
  header.writeUInt32LE(0, 72);
  header.fill(0xff, 76, 76 + HEADER_FAT_SLOTS * 4);
  for (let f = 0; f < fatSectors; f++) header.writeUInt32LE(usedBeforeFat + f, 76 + f * 4);

  const directory = Buffer.alloc(directorySectors * SECTOR_SIZE);
  for (let i = entries.length; i < directorySectors * ENTRIES_PER_SECTOR; i++) {
    const at = i * DIRECTORY_ENTRY_SIZE;
    directory.writeUInt32LE(NOSTREAM, at + 68);
    directory.writeUInt32LE(NOSTREAM, at + 72);
    directory.writeUInt32LE(NOSTREAM, at + 76);
  }
  entries.forEach((entry, index) => {
    const at = index * DIRECTORY_ENTRY_SIZE;
    const nameBytes = Buffer.from(entry.name, 'utf16le');
    if (nameBytes.length + 2 > MAX_NAME_UTF16_BYTES) throw new Error(`stream name too long: ${entry.name}`);
    nameBytes.copy(directory, at);
    directory.writeUInt16LE(nameBytes.length + 2, at + 64);
    directory.writeUInt8(entry.type, at + 66);
    const firstChild = entry.children.length > 0 ? entries.indexOf(entry.children[0]) : NOSTREAM;
    const sibling = (() => {
      const parent = entries.find((candidate) => candidate.children.includes(entry));
      if (!parent) return NOSTREAM;
      const position = parent.children.indexOf(entry);
      return position === parent.children.length - 1 ? NOSTREAM : entries.indexOf(parent.children[position + 1]);
    })();
    directory.writeUInt32LE(NOSTREAM, at + 68);
    directory.writeUInt32LE(sibling, at + 72);
    directory.writeUInt32LE(firstChild, at + 76);
    directory.writeUInt32LE(entry.start, at + 116);
    directory.writeUInt32LE(entry.size, at + 120);
  });

  return Buffer.concat([header, directory, miniFat, miniStream.length > 0 ? Buffer.concat([miniStream, Buffer.alloc(miniStreamSectors * SECTOR_SIZE - miniStream.length)]) : Buffer.alloc(0), ...dataChunks, fat]);
}
