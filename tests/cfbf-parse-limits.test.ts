import { describe, expect, it } from 'vitest';
import { buildCfbfContainer, type CfbfNode } from '../src/lib/conversions/cfbf-writer';
import { parseCfbf, parseHwpDocument } from '../src/lib/conversions/hwp';
import { convertXlsSource, xlsHasFilePass } from '../src/lib/conversions/office';
import { LEGACY_OFFICE_MAX_INPUT_BYTES } from '../src/lib/conversions/office/legacy-office-limits';
import { CorruptStreamError } from '../src/lib/types';
import { entryFields, entryId, setEntry, setFatEntry, setMiniFatEntry } from './helpers/cfbf-layout';
import { expectNoHang } from './helpers/timing';

/**
 * What a compound file ([MS-CFB]) may not make the parser do: read one sector for two chains, follow a chain, a FAT sector list, a
 * DIFAT chain or a directory tree around a loop, copy more stream bytes than the file's sectors hold, build more directory entries
 * than the limit, nest storages deeper than the limit or spell out more path characters than the budget, or read a file larger than
 * the legacy Office readers accept. Each is refused with the typed corrupt-stream error (status 400), so a hostile file cannot make the
 * parser loop or hold many times its own size.
 */

const STREAM_BYTES = 16 * 1024;
const MINI_STREAM_BYTES = 300;
const SECTOR_BYTES = 512;
const MINI_SECTOR_BYTES = 64;
const MAX_DIRECTORY_ENTRIES = 65_536;
const FAT_SECTOR_COUNT_OFFSET = 44;
const HEADER_DIFAT_OFFSET = 76;

const END_OF_CHAIN = 0xfffffffe;
const NO_ENTRY = 0xffffffff;
const MAX_STORAGE_DEPTH = 1000;
const MAX_PATH_CHARS = 16 * 1024 * 1024;
const BYTES_PER_MIB = 1024 * 1024;

const filled = (size: number, byte: number): Buffer => Buffer.alloc(size, byte);
const startOf = (file: Buffer, name: string): number => entryFields(file, entryId(file, name)).start;

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
    const externalBefore = process.memoryUsage().arrayBuffers;
    expect(() => parseCfbf(file)).toThrow(CorruptStreamError);
    // The entries declare 512 MiB over a file of under 1 MiB.
    expect(process.memoryUsage().arrayBuffers - externalBefore).toBeLessThan(64 * 1024 * 1024);
  });
});

describe('the FAT sector list', () => {
  it('refuses a FAT sector listed twice', () => {
    const file = buildCfbfContainer([{ name: 'A', data: filled(STREAM_BYTES, 0x41) }]);
    expect(file.readUInt32LE(FAT_SECTOR_COUNT_OFFSET)).toBe(1);
    file.writeUInt32LE(2, FAT_SECTOR_COUNT_OFFSET);
    file.writeUInt32LE(file.readUInt32LE(HEADER_DIFAT_OFFSET), HEADER_DIFAT_OFFSET + 4);
    expect(() => parseCfbf(file)).toThrow(CorruptStreamError);
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
 * A version 4 file (4096-byte sectors, [MS-CFB] 2.2) holding only a directory: the root entry and `entryCount - 1` storages that
 * the tree does not reach, unless `linksOf` gives an entry other links, another type or a size.
 */
function directoryOnlyFile(entryCount: number, linksOf: (id: number) => EntryLinks = () => ({})): Buffer {
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
    file.write(name, at, 'utf16le');
    file.writeUInt16LE((name.length + 1) * 2, at + 64);
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
    expect(() => parseCfbf(directoryOnlyFile(MAX_DIRECTORY_ENTRIES + 1))).toThrow(CorruptStreamError);
  });
});

async function expectRefused(label: string, file: Buffer, reason: RegExp): Promise<void> {
  await expectNoHang(label, () => expect(() => parseCfbf(file)).toThrow(CorruptStreamError));
  expect(() => parseCfbf(file)).toThrow(reason);
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

  it(`reads storages ${MAX_STORAGE_DEPTH} deep and refuses one more`, async () => {
    const path = `${'abcdefghijklmno/'.repeat(MAX_STORAGE_DEPTH)}leaf`;
    expect(parseCfbf(buildCfbfContainer(storageChain(MAX_STORAGE_DEPTH, [leaf('leaf')]))).paths.get(path)).toEqual(filled(1, 0x4c));
    await expectRefused('depth past the limit', buildCfbfContainer(storageChain(MAX_STORAGE_DEPTH + 1, [leaf('leaf')])), /storages are nested more than 1000 deep/);
  });

  it('refuses a chain of every entry of a full directory without recursing', async () => {
    const entryCount = MAX_DIRECTORY_ENTRIES;
    const chain = directoryOnlyFile(entryCount, (id) => (id + 1 < entryCount ? { child: id + 1 } : {}));
    await expectRefused('65,536 nested storages', chain, /storages are nested more than 1000 deep/);
  });

  it('refuses names that spell out more path characters than the budget', async () => {
    const streams = (count: number): CfbfNode[] => Array.from({ length: count }, (_, index) => leaf(`s${index}`));
    const nameChars = 16;
    const storagePathChars = nameChars * ((MAX_STORAGE_DEPTH * (MAX_STORAGE_DEPTH + 1)) / 2) - MAX_STORAGE_DEPTH;
    const streamPathChars = MAX_STORAGE_DEPTH * nameChars + 5;
    const within = 500;
    const over = 600;
    expect(storagePathChars + within * streamPathChars).toBeLessThan(MAX_PATH_CHARS);
    expect(storagePathChars + over * (streamPathChars - 2)).toBeGreaterThan(MAX_PATH_CHARS);
    expect(parseCfbf(buildCfbfContainer(storageChain(MAX_STORAGE_DEPTH, streams(within)))).paths.size).toBe(within);
    await expectRefused('path budget', buildCfbfContainer(storageChain(MAX_STORAGE_DEPTH, streams(over))), /paths of its entries spell out more than 16777216 characters/);
  });
});

describe('sizes and sector numbers that no file can hold', () => {
  const arrayBuffersGrowth = (run: () => void): number => {
    const before = process.memoryUsage().arrayBuffers;
    run();
    return process.memoryUsage().arrayBuffers - before;
  };

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
    setFatEntry(file, startOf(file, 'A') + 3, 0x7ffffff0);
    await expectRefused('FAT entry past the FAT', file, CHAIN_TOO_SHORT);
  });

  it('refuses a FAT sector list that names a sector past the end of the file', async () => {
    const file = threeStreams(STREAM_BYTES);
    file.writeUInt32LE(0x7ffffff0, HEADER_DIFAT_OFFSET);
    await expectRefused('FAT list past the end', file, CHAIN_TOO_SHORT);
  });

  it('refuses a stream of 2^40 bytes declared by a version 4 entry without copying more than the file holds', () => {
    const file = directoryOnlyFile(2, (id) => (id === 0 ? { child: 1 } : { type: 2, size: 1n << 40n }));
    expect(arrayBuffersGrowth(() => expect(() => parseCfbf(file)).toThrow(/its streams declare 1099511627776 bytes/))).toBeLessThan(BYTES_PER_MIB);
  });
});

describe('the size of the file', () => {
  const oversized = (): Buffer => {
    const file = Buffer.alloc(LEGACY_OFFICE_MAX_INPUT_BYTES + 1);
    threeStreams(MINI_STREAM_BYTES).copy(file);
    return file;
  };

  it(`refuses a file of more than ${LEGACY_OFFICE_MAX_INPUT_BYTES} bytes before reading any of it and reads one of exactly that size`, () => {
    const file = oversized();
    expect(() => parseCfbf(file)).toThrow(CorruptStreamError);
    expect(() => parseCfbf(file)).toThrow(`exceeds the ${LEGACY_OFFICE_MAX_INPUT_BYTES}-byte limit`);
    expect(parseCfbf(file.subarray(0, LEGACY_OFFICE_MAX_INPUT_BYTES)).paths.get('A')).toEqual(filled(MINI_STREAM_BYTES, 0x41));
  });

  it('is the bound of every reader that parses a compound file in full', async () => {
    const file = oversized();
    expect(() => parseHwpDocument(file)).toThrow(CorruptStreamError);
    await expect(convertXlsSource(file, 'csv', {}, 'big')).rejects.toBeInstanceOf(CorruptStreamError);
    expect(xlsHasFilePass(file)).toBe(false);
  });
});
