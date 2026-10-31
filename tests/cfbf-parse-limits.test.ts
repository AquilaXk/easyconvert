import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CFBF_DIRECTORY_ENTRY_BYTES, CFBF_MAX_DIRECTORY_ENTRIES, CFBF_MAX_FILE_BYTES, CFBF_MAX_PATH_CHARS, CFBF_MAX_STORAGE_DEPTH, readCompoundFileRoot } from '../src/lib/compound-file-kind';
import { buildCfbfContainer, type CfbfNode } from '../src/lib/conversions/cfbf-writer';
import { parseCfbf } from '../src/lib/conversions/cfbf-reader';
import { parseHwpDocument } from '../src/lib/conversions/hwp';
import { convertXlsSource, xlsHasFilePass } from '../src/lib/conversions/office';
import { readCfbContainer } from '../src/lib/conversions/office/cfb-streams';
import { LegacyOfficeFormatError } from '../src/lib/conversions/office/legacy-office-errors';
import { CompoundFileStructureError, CorruptStreamError } from '../src/lib/types';
import { entryFields, entryId, setEntry, setFatEntry, setMiniFatEntry } from './helpers/cfbf-layout';
import { arrayBuffersGrowth } from './helpers/cfbf-large';
import { expectNoHang } from './helpers/timing';

/**
 * What a compound file ([MS-CFB]) may not make the parser do: read one sector for two chains or for a chain and the FAT, follow a
 * chain, a FAT sector list, a DIFAT chain or a directory tree around a loop, end a directory or mini FAT chain outside the file or
 * the FAT, copy more stream bytes than the file's sectors hold, read a directory of more slots than the limit, take the mini stream
 * cutoff from the header, nest storages deeper than the limit or spell out more path characters than the budget, or read a file
 * larger than the legacy Office readers accept. Each is refused with the typed corrupt-stream error (status 400), so a hostile file
 * cannot make the parser loop or hold many times its own size.
 */

const STREAM_BYTES = 16 * 1024;
const MINI_STREAM_BYTES = 300;
const SECTOR_BYTES = 512;
const MINI_SECTOR_BYTES = 64;
const MAX_DIRECTORY_ENTRIES = CFBF_MAX_DIRECTORY_ENTRIES;
const MINI_STREAM_CUTOFF_OFFSET = 56;
const MINI_STREAM_CUTOFF_BYTES = 4096;
const FIRST_MINI_FAT_SECTOR_OFFSET = 60;
const MINI_FAT_SECTOR_COUNT_OFFSET = 64;
const FIRST_DIFAT_SECTOR_OFFSET = 68;
const DIFAT_SECTOR_COUNT_OFFSET = 72;
const FIRST_DIRECTORY_SECTOR_OFFSET = 48;
const MAX_UNREACHABLE_SECTOR = 0x7ffffff0;
const FAT_SECTOR_COUNT_OFFSET = 44;
const HEADER_DIFAT_OFFSET = 76;

const END_OF_CHAIN = 0xfffffffe;
const NO_ENTRY = 0xffffffff;
const MAX_STORAGE_DEPTH = CFBF_MAX_STORAGE_DEPTH;
const MAX_PATH_CHARS = CFBF_MAX_PATH_CHARS;
const BYTES_PER_MIB = 1024 * 1024;
const DIRECTORY_READ_CAP_BYTES = (MAX_DIRECTORY_ENTRIES + 1) * CFBF_DIRECTORY_ENTRY_BYTES;

const filled = (size: number, byte: number): Buffer => Buffer.alloc(size, byte);
const startOf = (file: Buffer, name: string): number => entryFields(file, entryId(file, name)).start;

/** What `parseCfbf` throws for the file, or undefined when it parses. */
const refusalOf = (file: Buffer): unknown => {
  try {
    parseCfbf(file);
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('sectors that belong to two chains', () => {
  const twoStreams = (size: number): Buffer =>
    buildCfbfContainer([
      { name: 'A', data: filled(size, 0x41) },
      { name: 'B', data: filled(size, 0x42) },
    ]);

  it('reads a file whose streams each have their own sectors', () => {
    for (const size of [STREAM_BYTES, MINI_STREAM_BYTES]) {
      const container = parseCfbf(twoStreams(size));
      expect(container.paths.get('A')).toEqual(filled(size, 0x41));
      expect(container.paths.get('B')).toEqual(filled(size, 0x42));
    }
  });

  it.each([
    ['starts on the first sector of the other', 0, STREAM_BYTES],
    ['starts inside the chain of the other', 8, 8 * SECTOR_BYTES],
  ])('refuses a stream that %s', (_, sectorsIn, size) => {
    const file = twoStreams(STREAM_BYTES);
    setEntry(file, entryId(file, 'B'), { start: startOf(file, 'A') + sectorsIn, size });
    expect(() => parseCfbf(file)).toThrow(CorruptStreamError);
  });

  it('refuses a mini stream that starts inside the mini chain of another', () => {
    const file = twoStreams(MINI_STREAM_BYTES);
    // A's mini sectors from its second on hold 256 bytes, so B is not cut short by the end of the chain.
    setEntry(file, entryId(file, 'B'), { start: startOf(file, 'A') + 1, size: 4 * MINI_SECTOR_BYTES });
    expect(() => parseCfbf(file)).toThrow(CorruptStreamError);
  });

  it('refuses many entries that share one long chain without copying it for each', () => {
    const chainBytes = 512 * 1024;
    const sharers = 1024;
    const file = buildCfbfContainer([
      { name: 'Long', data: filled(chainBytes, 0x4c) },
      ...Array.from({ length: sharers }, (_, index) => ({ name: `s${index}`, data: filled(1, 0x73) })),
    ]);
    const longStart = startOf(file, 'Long');
    for (let id = 1; id <= sharers + 1; id++) {
      if (entryFields(file, id).name.startsWith('s')) setEntry(file, id, { start: longStart, size: chainBytes });
    }
    // The entries declare 512 MiB over a file of under 1 MiB.
    expect(arrayBuffersGrowth(() => expect(() => parseCfbf(file)).toThrow(CorruptStreamError))).toBeLessThan(64 * 1024 * 1024);
  });

  it('refuses a stream that starts on a FAT sector', () => {
    const file = twoStreams(STREAM_BYTES);
    setEntry(file, entryId(file, 'B'), { start: file.readUInt32LE(HEADER_DIFAT_OFFSET), size: MINI_STREAM_CUTOFF_BYTES });
    expect(() => parseCfbf(file)).toThrow(/reads sector \d+, which holds the FAT or the DIFAT/);
  });

  it('refuses a stream that starts on a DIFAT sector', () => {
    const file = buildCfbfContainer([{ name: 'Big', data: filled(8 * BYTES_PER_MIB, 0x42) }]);
    expect(file.readUInt32LE(DIFAT_SECTOR_COUNT_OFFSET)).toBe(1);
    // The layout helpers read only the 109 FAT sectors of the header, so the entry is addressed here: the root entry, then `Big`.
    const bigEntryAt = (file.readUInt32LE(FIRST_DIRECTORY_SECTOR_OFFSET) + 1) * SECTOR_BYTES + CFBF_DIRECTORY_ENTRY_BYTES;
    expect(file.toString('utf16le', bigEntryAt, bigEntryAt + 'Big'.length * 2)).toBe('Big');
    file.writeUInt32LE(file.readUInt32LE(FIRST_DIFAT_SECTOR_OFFSET), bigEntryAt + 116);
    file.writeUInt32LE(MINI_STREAM_CUTOFF_BYTES, bigEntryAt + 120);
    expect(() => parseCfbf(file)).toThrow(/reads sector \d+, which holds the FAT or the DIFAT/);
  });
});

describe('the FAT sector list', () => {
  it('ends at the first FAT sector past the file, so the FAT never outgrows the file', () => {
    const streams = [{ name: 'A', data: filled(80 * 1024, 0x41) }];
    const file = buildCfbfContainer(streams);
    expect(file.readUInt32LE(FAT_SECTOR_COUNT_OFFSET)).toBe(2);
    expect(parseCfbf(file).paths.get('A')).toEqual(filled(80 * 1024, 0x41));

    const cut = buildCfbfContainer(streams);
    cut.writeUInt32LE(cut.readUInt32LE(HEADER_DIFAT_OFFSET + 4), HEADER_DIFAT_OFFSET + 8);
    cut.writeUInt32LE(MAX_UNREACHABLE_SECTOR, HEADER_DIFAT_OFFSET + 4);
    cut.writeUInt32LE(3, FAT_SECTOR_COUNT_OFFSET);
    expect(() => parseCfbf(cut)).toThrow(/sector chain/);
  });

  it('refuses a FAT sector listed twice', () => {
    const file = buildCfbfContainer([{ name: 'A', data: filled(80 * 1024, 0x41) }]);
    expect(file.readUInt32LE(FAT_SECTOR_COUNT_OFFSET)).toBe(2);
    file.writeUInt32LE(file.readUInt32LE(HEADER_DIFAT_OFFSET), HEADER_DIFAT_OFFSET + 4);
    expect(() => parseCfbf(file)).toThrow(/the FAT sector list names sector \d+ twice/);
  });
});

interface EntryLinks {
  type?: number;
  left?: number;
  right?: number;
  child?: number;
  size?: bigint;
}

/**
 * A version 4 file (4096-byte sectors, [MS-CFB] 2.2) holding only a directory of `entryCount` slots: the root entry and storages
 * that the tree does not reach, unless `linksOf` gives an entry other links, another type or a size. Only the first `namedEntries`
 * slots carry a name; the others are free slots, which a reader skips.
 */
function directoryOnlyFile(entryCount: number, linksOf: (id: number) => EntryLinks = () => ({}), namedEntries = entryCount): Buffer {
  const sectorBytes = 4096;
  const entriesPerSector = sectorBytes / 128;
  const fatEntriesPerSector = sectorBytes / 4;
  const directorySectors = Math.ceil(entryCount / entriesPerSector);
  let fatSectors = 1;
  while (fatSectors * fatEntriesPerSector < directorySectors + fatSectors) fatSectors++;
  const file = Buffer.alloc((1 + fatSectors + directorySectors) * sectorBytes);
  const sectorOffset = (sector: number): number => (sector + 1) * sectorBytes;
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(file, 0);
  file.writeUInt16LE(0x3e, 24);
  file.writeUInt16LE(4, 26);
  file.writeUInt16LE(0xfffe, 28);
  file.writeUInt16LE(12, 30);
  file.writeUInt16LE(6, 32);
  file.writeUInt32LE(directorySectors, 40);
  file.writeUInt32LE(fatSectors, 44);
  file.writeUInt32LE(fatSectors, 48);
  file.writeUInt32LE(4096, 56);
  file.writeUInt32LE(END_OF_CHAIN, 60);
  file.writeUInt32LE(END_OF_CHAIN, 68);
  for (let index = 0; index < 109; index++) file.writeUInt32LE(index < fatSectors ? index : 0xffffffff, 76 + index * 4);
  for (let sector = 0; sector < fatSectors * fatEntriesPerSector; sector++) {
    let next = 0xffffffff;
    if (sector < fatSectors) next = 0xfffffffd;
    else if (sector < fatSectors + directorySectors) next = sector === fatSectors + directorySectors - 1 ? 0xfffffffe : sector + 1;
    file.writeUInt32LE(next, sectorOffset(Math.floor(sector / fatEntriesPerSector)) + (sector % fatEntriesPerSector) * 4);
  }
  for (let id = 0; id < entryCount; id++) {
    const at = sectorOffset(fatSectors + Math.floor(id / entriesPerSector)) + (id % entriesPerSector) * 128;
    const name = id === 0 ? 'Root Entry' : 'e';
    if (id < namedEntries) {
      file.write(name, at, 'utf16le');
      file.writeUInt16LE((name.length + 1) * 2, at + 64);
    }
    const links = linksOf(id);
    file.writeUInt8(links.type ?? (id === 0 ? 5 : 1), at + 66);
    file.writeUInt32LE(links.left ?? NO_ENTRY, at + 68);
    file.writeUInt32LE(links.right ?? NO_ENTRY, at + 72);
    file.writeUInt32LE(links.child ?? NO_ENTRY, at + 76);
    file.writeUInt32LE(END_OF_CHAIN, at + 116);
    file.writeBigUInt64LE(links.size ?? 0n, at + 120);
  }
  return file;
}

describe('the number of directory entries', () => {
  it(`reads a directory of ${MAX_DIRECTORY_ENTRIES} entries and refuses one more`, () => {
    expect(parseCfbf(directoryOnlyFile(MAX_DIRECTORY_ENTRIES)).directoryEntries).toHaveLength(MAX_DIRECTORY_ENTRIES);
    expect(() => parseCfbf(directoryOnlyFile(MAX_DIRECTORY_ENTRIES + 1))).toThrow(/its directory holds more than 65536 entries/);
  });

  it('counts the free slots of the directory, as the check of the file kind does', () => {
    const atTheLimit = directoryOnlyFile(MAX_DIRECTORY_ENTRIES, undefined, 1);
    const pastIt = directoryOnlyFile(MAX_DIRECTORY_ENTRIES + 1, undefined, 1);
    expect(parseCfbf(atTheLimit).directoryEntries).toHaveLength(1);
    expect(readCompoundFileRoot(atTheLimit).status).toBe('read');
    expect(() => parseCfbf(pastIt)).toThrow(CorruptStreamError);
    expect(readCompoundFileRoot(pastIt).status).toBe('malformed');
  });

  it('reads no more of a longer directory chain than the limit allows', () => {
    const file = directoryOnlyFile(4 * MAX_DIRECTORY_ENTRIES, undefined, 1);
    expect(arrayBuffersGrowth(() => expect(() => parseCfbf(file)).toThrow(CorruptStreamError))).toBeLessThan(2 * DIRECTORY_READ_CAP_BYTES);
  });
});

async function expectRefused(label: string, file: Buffer, reason: RegExp, refusedAs: typeof CorruptStreamError = CorruptStreamError): Promise<void> {
  const refusal = await expectNoHang(label, () => refusalOf(file));
  expect(refusal).toBeInstanceOf(refusedAs);
  expect((refusal as Error).message).toMatch(reason);
}

const RETURNS_TO_SECTOR = /chain starting at sector \d+ returns to sector/;
const RETURNS_TO_MINI_SECTOR = /chain starting at mini sector \d+ returns to mini sector/;
const CHAIN_TOO_SHORT = /declares \d+ bytes but its sector chain holds/;

const threeStreams = (size: number): Buffer =>
  buildCfbfContainer([
    { name: 'A', data: filled(size, 0x41) },
    { name: 'B', data: filled(size, 0x42) },
    { name: 'C', data: filled(size, 0x43) },
  ]);

describe('chains that return to themselves', () => {
  it('refuses a sector chain whose FAT entry points at its own sector', async () => {
    const file = threeStreams(STREAM_BYTES);
    setFatEntry(file, startOf(file, 'A'), startOf(file, 'A'));
    await expectRefused('FAT self loop', file, RETURNS_TO_SECTOR);
  });

  it('refuses a sector chain whose last sector returns to its first', async () => {
    const file = threeStreams(STREAM_BYTES);
    const first = startOf(file, 'A');
    setFatEntry(file, first + STREAM_BYTES / SECTOR_BYTES - 1, first);
    setEntry(file, entryId(file, 'A'), { size: 2 * STREAM_BYTES });
    for (const name of ['B', 'C']) setEntry(file, entryId(file, name), { size: SECTOR_BYTES * 8 });
    await expectRefused('FAT cycle', file, RETURNS_TO_SECTOR);
  });

  it('refuses a directory chain that returns to its first sector', async () => {
    const file = threeStreams(STREAM_BYTES);
    const directoryStart = file.readUInt32LE(48);
    setFatEntry(file, directoryStart, directoryStart);
    await expectRefused('directory cycle', file, RETURNS_TO_SECTOR);
  });

  it('refuses a mini stream chain whose mini FAT entry points at its own mini sector', async () => {
    const file = threeStreams(MINI_STREAM_BYTES);
    const first = startOf(file, 'A');
    setMiniFatEntry(file, first, first);
    setEntry(file, entryId(file, 'A'), { size: 4 * MINI_SECTOR_BYTES });
    await expectRefused('mini FAT self loop', file, RETURNS_TO_MINI_SECTOR);
  });

  it('refuses a mini stream chain whose last mini sector returns to its first', async () => {
    const file = threeStreams(MINI_STREAM_BYTES);
    const first = startOf(file, 'A');
    setMiniFatEntry(file, first + Math.ceil(MINI_STREAM_BYTES / MINI_SECTOR_BYTES) - 1, first);
    setEntry(file, entryId(file, 'A'), { size: 5 * MINI_SECTOR_BYTES + 20 });
    await expectRefused('mini FAT cycle', file, RETURNS_TO_MINI_SECTOR);
  });

  it('refuses a DIFAT chain that returns to its own sector', async () => {
    const file = buildCfbfContainer([{ name: 'Big', data: filled(8 * BYTES_PER_MIB, 0x42) }]);
    const firstDifat = file.readUInt32LE(68);
    expect(file.readUInt32LE(72)).toBe(1);
    file.writeUInt32LE(firstDifat, (firstDifat + 1) * SECTOR_BYTES + SECTOR_BYTES - 4);
    file.writeUInt32LE(3, 72);
    await expectRefused('DIFAT cycle', file, /the DIFAT chain returns to sector/);
  });
});

describe('directory and mini FAT chains that end where the file or the FAT does not reach', () => {
  const firstDirectorySector = (file: Buffer): number => file.readUInt32LE(FIRST_DIRECTORY_SECTOR_OFFSET);
  const firstMiniFatSector = (file: Buffer): number => file.readUInt32LE(FIRST_MINI_FAT_SECTOR_OFFSET);
  /** Three streams of 3,000 bytes: a mini stream of 141 mini sectors, whose mini FAT takes two sectors. */
  const needingTwoMiniFatSectors = (): Buffer => threeStreams(3000);

  it('refuses a directory chain that runs to a sector past the file', async () => {
    const file = threeStreams(MINI_STREAM_BYTES);
    setFatEntry(file, firstDirectorySector(file), MAX_UNREACHABLE_SECTOR);
    await expectRefused('directory past the file', file, /sector chain starting at sector \d+ reaches sector \d+, which the file does not hold/, CompoundFileStructureError);
  });

  it('refuses a directory chain that runs to a sector the FAT does not cover', async () => {
    const fatEntries = SECTOR_BYTES / 4;
    const padded = Buffer.concat([threeStreams(MINI_STREAM_BYTES), Buffer.alloc(fatEntries * SECTOR_BYTES)]);
    setFatEntry(padded, firstDirectorySector(padded), fatEntries + 1);
    await expectRefused('directory past the FAT', padded, /sector chain starting at sector \d+ ends at sector \d+, which the FAT does not cover/, CompoundFileStructureError);
  });

  it('refuses a mini FAT chain that runs to a sector past the file, as far as the mini stream needs it', async () => {
    const file = needingTwoMiniFatSectors();
    file.writeUInt32LE(2, MINI_FAT_SECTOR_COUNT_OFFSET);
    setFatEntry(file, firstMiniFatSector(file), MAX_UNREACHABLE_SECTOR);
    await expectRefused('mini FAT past the file', file, /sector chain starting at sector \d+ reaches sector \d+, which the file does not hold/, CompoundFileStructureError);
  });

  it('reads a mini FAT chain that ends before the sectors the header counts', () => {
    const file = threeStreams(MINI_STREAM_BYTES);
    file.writeUInt32LE(2, MINI_FAT_SECTOR_COUNT_OFFSET);
    expect(parseCfbf(file).paths.get('A')).toEqual(filled(MINI_STREAM_BYTES, 0x41));
  });

  it('does not follow a mini FAT chain further than the mini stream can be addressed', () => {
    const file = threeStreams(MINI_STREAM_BYTES);
    file.writeUInt32LE(2, MINI_FAT_SECTOR_COUNT_OFFSET);
    setFatEntry(file, firstMiniFatSector(file), MAX_UNREACHABLE_SECTOR);
    expect(parseCfbf(file).paths.get('C')).toEqual(filled(MINI_STREAM_BYTES, 0x43));
  });
});

describe('a directory tree that returns to itself', () => {
  it.each([
    ['an entry that is its own right sibling', (file: Buffer) => setEntry(file, entryId(file, 'A'), { right: entryId(file, 'A') })],
    [
      'two siblings that link to each other',
      (file: Buffer) => {
        const top = entryFields(file, 0).child;
        const other = ['A', 'B', 'C', 'S'].map((name) => entryId(file, name)).find((id) => id !== top) as number;
        setEntry(file, top, { left: other });
        setEntry(file, other, { right: top });
      },
    ],
    ['a storage that is its own child', (file: Buffer) => setEntry(file, entryId(file, 'S'), { child: entryId(file, 'S') })],
  ])('refuses %s', async (_, damage) => {
    const file = buildCfbfContainer([
      { name: 'A', data: filled(MINI_STREAM_BYTES, 0x41) },
      { name: 'B', data: filled(MINI_STREAM_BYTES, 0x42) },
      { name: 'C', data: filled(MINI_STREAM_BYTES, 0x43) },
      { name: 'S', children: [{ name: 'T', data: filled(MINI_STREAM_BYTES, 0x54) }] },
    ]);
    damage(file);
    await expectRefused('directory tree cycle', file, /the directory tree reaches entry \d+ twice/);
  });
});

describe('a directory tree that nests storages deeply', () => {
  const storageChain = (depth: number, leaves: CfbfNode[]): CfbfNode[] => {
    let nodes = leaves;
    for (let level = 0; level < depth; level++) nodes = [{ name: 'abcdefghijklmno', children: nodes }];
    return nodes;
  };
  const leaf = (name: string): CfbfNode => ({ name, data: filled(1, 0x4c) });
  const BULK_NAME = 'bulk';
  /** A stream large enough that copying it shows in the array buffers. */
  const bulk = (): CfbfNode => ({ name: BULK_NAME, data: filled(4 * BYTES_PER_MIB, 0x42) });

  it(`reads storages ${MAX_STORAGE_DEPTH} deep and refuses one more before copying any stream`, async () => {
    const path = `${'abcdefghijklmno/'.repeat(MAX_STORAGE_DEPTH)}leaf`;
    expect(parseCfbf(buildCfbfContainer(storageChain(MAX_STORAGE_DEPTH, [leaf('leaf')]))).paths.get(path)).toEqual(filled(1, 0x4c));
    const tooDeep = buildCfbfContainer(storageChain(MAX_STORAGE_DEPTH + 1, [leaf('leaf'), bulk()]));
    expect(arrayBuffersGrowth(() => expect(() => parseCfbf(tooDeep)).toThrow(CorruptStreamError))).toBeLessThan(BYTES_PER_MIB);
    await expectRefused('depth past the limit', tooDeep, /storages are nested more than 1000 deep/);
  });

  it('refuses a chain of every entry of a full directory', async () => {
    const entryCount = MAX_DIRECTORY_ENTRIES;
    const chain = directoryOnlyFile(entryCount, (id) => (id + 1 < entryCount ? { child: id + 1 } : {}));
    await expectRefused('65,536 nested storages', chain, /storages are nested more than 1000 deep/);
  });

  describe('the path budget', () => {
    const nameChars = 'abcdefghijklmno'.length;
    /** Characters of the full paths of the 1,000 storages, each path one more name and a separator long than its parent's. */
    const storagePathChars = ((nameChars + 1) * MAX_STORAGE_DEPTH * (MAX_STORAGE_DEPTH + 1)) / 2 - MAX_STORAGE_DEPTH;
    /** Characters of the path of the deepest storage and its separator, which every stream in it starts with. */
    const streamPathPrefixChars = (nameChars + 1) * MAX_STORAGE_DEPTH;
    const STREAMS = 547;
    /** The characters the names of the 547 streams must add up to for all paths, the stream `bulk` included, to add up to the budget. */
    const NAME_CHARS_AT_BUDGET = MAX_PATH_CHARS - storagePathChars - (STREAMS + 1) * streamPathPrefixChars - BULK_NAME.length;

    /** `STREAMS` streams for the deepest storage whose names add up to `nameChars` characters. */
    const streamsWithNames = (nameChars: number): CfbfNode[] => {
      const base = Math.floor(nameChars / STREAMS);
      const longer = nameChars - base * STREAMS;
      return Array.from({ length: STREAMS }, (_, index) => leaf(index.toString(36).padStart(index < longer ? base + 1 : base, '0')));
    };

    it('is the arithmetic that the files below rely on', () => {
      expect(NAME_CHARS_AT_BUDGET).toBeGreaterThan(STREAMS * 2);
      expect(NAME_CHARS_AT_BUDGET).toBeLessThan(STREAMS * 6);
    });

    it(`reads paths that add up to exactly ${MAX_PATH_CHARS} characters and refuses one more, before copying any stream`, async () => {
      const atBudget = buildCfbfContainer(storageChain(MAX_STORAGE_DEPTH, [...streamsWithNames(NAME_CHARS_AT_BUDGET), bulk()]));
      expect(parseCfbf(atBudget).paths.size).toBe(STREAMS + 1);

      const overBudget = buildCfbfContainer(storageChain(MAX_STORAGE_DEPTH, [...streamsWithNames(NAME_CHARS_AT_BUDGET + 1), bulk()]));
      expect(arrayBuffersGrowth(() => expect(() => parseCfbf(overBudget)).toThrow(CorruptStreamError))).toBeLessThan(BYTES_PER_MIB);
      await expectRefused('path budget', overBudget, /paths of its entries spell out more than 16777216 characters/);
    });
  });
});

describe('sizes and sector numbers that no file can hold', () => {
  const DECLARES_MORE_THAN_THE_FILE = /its streams declare \d+ bytes in \d+ bytes of sectors and \d+ bytes in a \d+-byte mini stream/;
  it.each([
    ['a stream of 4 GiB less one byte in the sectors', threeStreams(STREAM_BYTES), { size: 0xffffffff }, DECLARES_MORE_THAN_THE_FILE],
    ['a mini stream of 4095 bytes in a mini stream of 960', threeStreams(MINI_STREAM_BYTES), { size: 4095 }, DECLARES_MORE_THAN_THE_FILE],
    ['a start sector past the end of the file', threeStreams(STREAM_BYTES), { start: 0x7fffffff }, CHAIN_TOO_SHORT],
    ['a mini stream that starts past the end of the mini stream', threeStreams(MINI_STREAM_BYTES), { start: 0x7fffffff }, CHAIN_TOO_SHORT],
  ])('refuses %s without copying more than the file holds', async (label, file, damage, reason) => {
    setEntry(file, entryId(file, 'A'), damage);
    expect(arrayBuffersGrowth(() => expect(() => parseCfbf(file)).toThrow(reason))).toBeLessThan(BYTES_PER_MIB);
    await expectRefused(label, file, reason);
  });

  it('refuses a FAT entry past the end of the FAT', async () => {
    const file = threeStreams(STREAM_BYTES);
    setFatEntry(file, startOf(file, 'A') + 3, MAX_UNREACHABLE_SECTOR);
    await expectRefused('FAT entry past the FAT', file, CHAIN_TOO_SHORT);
  });

  it('refuses a stream of 2^40 bytes declared by a version 4 entry without copying more than the file holds', () => {
    const file = directoryOnlyFile(2, (id) => (id === 0 ? { child: 1 } : { type: 2, size: 1n << 40n }));
    expect(arrayBuffersGrowth(() => expect(() => parseCfbf(file)).toThrow(/its streams declare 1099511627776 bytes/))).toBeLessThan(BYTES_PER_MIB);
  });
});

describe('the mini stream cutoff', () => {
  it('reads the cutoff of 4096 that every writer gives', () => {
    const file = threeStreams(MINI_STREAM_BYTES);
    expect(file.readUInt32LE(MINI_STREAM_CUTOFF_OFFSET)).toBe(MINI_STREAM_CUTOFF_BYTES);
    expect(parseCfbf(file).paths.get('A')).toEqual(filled(MINI_STREAM_BYTES, 0x41));
  });

  it.each([512, 4095, 4097, 0x7fffffff, 0xffffffff])('reads with the cutoff of 4096 whatever the header gives when no stream lies between the two: %i', (cutoff) => {
    const file = threeStreams(MINI_STREAM_BYTES);
    const control = parseCfbf(file);
    file.writeUInt32LE(cutoff, MINI_STREAM_CUTOFF_OFFSET);
    const parsed = parseCfbf(file);
    expect([...parsed.paths.keys()]).toEqual([...control.paths.keys()]);
    for (const [name, bytes] of control.paths) expect(parsed.paths.get(name), name).toEqual(bytes);
  });
});

describe('the bytes the parser holds while it reads', () => {
  const STREAMS = 2000;
  const STREAM_SIZE = 4000;
  const MINI_SECTORS_PER_STREAM = Math.ceil(STREAM_SIZE / MINI_SECTOR_BYTES);

  /** How many buffers `run` makes with the factories of `Buffer`. */
  const buffersMadeBy = (run: () => void): number => {
    const factories = (['alloc', 'allocUnsafe', 'allocUnsafeSlow', 'from', 'concat'] as const).map((name) => vi.spyOn(Buffer, name));
    try {
      run();
      return factories.reduce((total, factory) => total + factory.mock.calls.length, 0);
    } finally {
      factories.forEach((factory) => factory.mockRestore());
    }
  };

  it('makes one buffer for a stream and none for each of its mini sectors', () => {
    const file = buildCfbfContainer(Array.from({ length: STREAMS }, (_, index) => ({ name: `s${index}`, data: filled(STREAM_SIZE, index % 251) })));
    let container: ReturnType<typeof parseCfbf> | undefined;
    const buffers = buffersMadeBy(() => {
      container = parseCfbf(file);
    });
    expect(container?.paths.get(`s${STREAMS - 1}`)).toEqual(filled(STREAM_SIZE, (STREAMS - 1) % 251));
    expect(container?.paths.size).toBe(STREAMS);
    // One per stream, plus the directory, the mini FAT and the mini stream; a buffer for each mini sector would make 63 times as many.
    expect(buffers).toBeLessThan(2 * STREAMS);
  });
});

describe('the size of the file', () => {
  let oversized: Buffer;
  beforeAll(() => {
    oversized = Buffer.alloc(CFBF_MAX_FILE_BYTES + 1);
    threeStreams(MINI_STREAM_BYTES).copy(oversized);
  });
  afterAll(() => {
    oversized = Buffer.alloc(0);
  });

  it(`refuses a file of more than ${CFBF_MAX_FILE_BYTES} bytes before reading any of it and reads one of exactly that size`, () => {
    expect(() => parseCfbf(oversized)).toThrow(CorruptStreamError);
    expect(() => parseCfbf(oversized)).toThrow(`larger than the ${CFBF_MAX_FILE_BYTES}-byte limit`);
    expect(parseCfbf(oversized.subarray(0, CFBF_MAX_FILE_BYTES)).paths.get('A')).toEqual(filled(MINI_STREAM_BYTES, 0x41));
  });

  it('is the limit of the legacy Office readers, which answer it in their own words with the label of the document', () => {
    expect(() => readCfbContainer(oversized, 'Word document')).toThrow(LegacyOfficeFormatError);
    expect(() => readCfbContainer(oversized, 'Word document')).toThrow(`Word document: the compound file is malformed (The compound file is larger than the ${CFBF_MAX_FILE_BYTES}-byte limit.).`);
  });

  it('is the bound of every reader that parses a compound file in full', async () => {
    expect(() => parseHwpDocument(oversized)).toThrow(CorruptStreamError);
    await expect(convertXlsSource(oversized, 'csv', {}, 'big')).rejects.toBeInstanceOf(CorruptStreamError);
    expect(xlsHasFilePass(oversized)).toBe(false);
  });
});
