import { describe, expect, it } from 'vitest';
import { buildCfbfContainer } from '../src/lib/conversions/cfbf-writer';
import { parseCfbf } from '../src/lib/conversions/hwp';
import { CorruptStreamError } from '../src/lib/types';
import { entryFields, entryId, setEntry } from './helpers/cfbf-layout';

/**
 * What a compound file ([MS-CFB]) may not make the parser do: read one sector for two chains, copy more stream bytes than the
 * file's sectors hold, read a FAT sector twice, or build more directory entries than the limit. Each is refused with the typed
 * corrupt-stream error, so a hostile file cannot make the parser hold many times its own size.
 */

const STREAM_BYTES = 16 * 1024;
const MINI_STREAM_BYTES = 300;
const SECTOR_BYTES = 512;
const MINI_SECTOR_BYTES = 64;
const MAX_DIRECTORY_ENTRIES = 65_536;
const FAT_SECTOR_COUNT_OFFSET = 44;
const HEADER_DIFAT_OFFSET = 76;

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

/**
 * A version 4 file (4096-byte sectors, [MS-CFB] 2.2) holding only a directory: the root entry and `entryCount - 1` storages that
 * the tree does not reach.
 */
function directoryOnlyFile(entryCount: number): Buffer {
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
  file.writeUInt32LE(0xfffffffe, 60);
  file.writeUInt32LE(0xfffffffe, 68);
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
    file.writeUInt8(id === 0 ? 5 : 1, at + 66);
    file.writeUInt32LE(0xffffffff, at + 68);
    file.writeUInt32LE(0xffffffff, at + 72);
    file.writeUInt32LE(0xffffffff, at + 76);
    file.writeUInt32LE(0xfffffffe, at + 116);
  }
  return file;
}

describe('the number of directory entries', () => {
  it(`reads a directory of ${MAX_DIRECTORY_ENTRIES} entries and refuses one more`, () => {
    expect(parseCfbf(directoryOnlyFile(MAX_DIRECTORY_ENTRIES)).directoryEntries).toHaveLength(MAX_DIRECTORY_ENTRIES);
    expect(() => parseCfbf(directoryOnlyFile(MAX_DIRECTORY_ENTRIES + 1))).toThrow(CorruptStreamError);
  });
});
