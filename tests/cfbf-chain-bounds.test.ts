import { describe, expect, it } from 'vitest';
import { buildCfbfContainer } from '../src/lib/conversions/cfbf-writer';
import { parseCfbf } from '../src/lib/conversions/cfbf-reader';
import { CorruptStreamError } from '../src/lib/types';
import {
  END_OF_CHAIN,
  FAT_SECTOR_MARK,
  FREE_SECTOR,
  LARGE_FAT_ENTRIES_PER_SECTOR,
  LARGE_SECTOR_BYTES,
  arrayBuffersGrowth,
  largeFile,
} from './helpers/cfbf-large';

/**
 * What a compound file may make the parser hold or claim. The tables it builds are no larger than the file can use: the FAT as many
 * sectors as map the file, the mini FAT as many entries as the mini stream has mini sectors, and none at all when there is no mini
 * stream. A chain claims the sectors its stream declares and no more, and a file cut short of a stream's last sector gives that
 * stream only the bytes the file holds. A mini stream cutoff in the header that disagrees with the parser's is refused when a stream
 * lies between the two.
 */

const MIB = 1024 * 1024;

describe('the tables the parser holds while it reads', () => {
  const SECTORS = 8192;
  const TABLE_SECTORS = SECTORS / LARGE_FAT_ENTRIES_PER_SECTOR;
  const FAT_SECTORS = Array.from({ length: TABLE_SECTORS }, (_, index) => index);
  const DIRECTORY = TABLE_SECTORS;
  const FILE_BYTES = (SECTORS + 1) * LARGE_SECTOR_BYTES;
  const MINI_SECTOR_BYTES = 64;
  const MINI_STREAM_BYTES = 1 * MIB;
  const MINI_STREAM_SECTORS = MINI_STREAM_BYTES / LARGE_SECTOR_BYTES;
  const ALL_MINI_FAT_SECTORS = 0xffffffff;

  it('reads no mini FAT for a file with no mini stream, whatever chain the header gives it', () => {
    const file = largeFile({
      sectors: SECTORS,
      directorySector: DIRECTORY,
      fatSectors: FAT_SECTORS,
      runs: [{ first: DIRECTORY + 1, length: SECTORS - DIRECTORY - 1 }],
      miniFat: { first: DIRECTORY + 1, headerCount: ALL_MINI_FAT_SECTORS },
    });
    expect(FILE_BYTES).toBe(file.length);
    let entries = 0;
    const growth = arrayBuffersGrowth(() => {
      entries = parseCfbf(file).directoryEntries.length;
    });
    expect(entries).toBe(1);
    expect(growth).toBeLessThan(FILE_BYTES / 32);
  });

  it('reads of the mini FAT only the entries that its mini stream can address', () => {
    const miniFatFirst = DIRECTORY + 1 + MINI_STREAM_SECTORS;
    const file = largeFile({
      sectors: SECTORS,
      directorySector: DIRECTORY,
      fatSectors: FAT_SECTORS,
      runs: [
        { first: DIRECTORY + 1, length: MINI_STREAM_SECTORS },
        { first: miniFatFirst, length: SECTORS - miniFatFirst },
      ],
      root: { start: DIRECTORY + 1, size: MINI_STREAM_BYTES },
      miniFat: { first: miniFatFirst, headerCount: ALL_MINI_FAT_SECTORS },
    });
    const addressableEntries = MINI_STREAM_BYTES / MINI_SECTOR_BYTES;
    let entries = 0;
    const growth = arrayBuffersGrowth(() => {
      entries = parseCfbf(file).directoryEntries.length;
    });
    expect(entries).toBe(1);
    expect(growth).toBeLessThan(MINI_STREAM_BYTES + addressableEntries * 4 * 2 + MIB / 4);
  });

  it('lists as FAT sectors no more than map the file, whatever sectors the header and the DIFAT name', () => {
    const difatCount = Math.ceil((SECTORS - 109) / (LARGE_FAT_ENTRIES_PER_SECTOR - 1));
    const difat = Array.from({ length: difatCount }, (_, index) => SECTORS - difatCount + index);
    const directory = SECTORS - difatCount - 1;
    const everySector = Array.from({ length: directory }, (_, index) => index);
    const file = largeFile({ sectors: SECTORS, directorySector: directory, fatSectors: everySector, difatSectors: difat });
    let entries = 0;
    const growth = arrayBuffersGrowth(() => {
      entries = parseCfbf(file).directoryEntries.length;
    });
    expect(entries).toBe(1);
    expect(growth).toBeLessThan(FILE_BYTES / 32);
  });

  it('reads a mini stream of exactly the mini sectors that one mini FAT sector maps', () => {
    const streams = Array.from({ length: 4 }, (_, index) => ({ name: `s${index}`, data: Buffer.alloc(2048, 0x61 + index) }));
    const file = buildCfbfContainer(streams);
    const parsed = parseCfbf(file);
    for (const stream of streams) expect(parsed.paths.get(stream.name), stream.name).toEqual(stream.data);
  });

  it('reads a mini stream that needs a second mini FAT sector', () => {
    const sizes = [4000, 4000, 200];
    const streams = sizes.map((size, index) => ({ name: `m${index}`, data: Buffer.alloc(size, 0x41 + index) }));
    const parsed = parseCfbf(buildCfbfContainer(streams));
    for (const stream of streams) expect(parsed.paths.get(stream.name), stream.name).toEqual(stream.data);
  });
});

describe('the bytes a chain gives to its stream', () => {
  const STREAM_BYTES = 5000;
  const TAIL_BYTES = STREAM_BYTES - LARGE_SECTOR_BYTES;
  const pattern = (size: number, seed: number): Buffer => Buffer.from(Array.from({ length: size }, (_, index) => (index * 7 + seed) % 251));
  const sectorAt = (sector: number): number => (sector + 1) * LARGE_SECTOR_BYTES;

  /** FAT at sector 0, directory at 1, and the stream `S` on sectors 2 and 3, the last of the file. */
  function singleStream(): Buffer {
    const file = largeFile({ sectors: 4, directorySector: 1, fatSectors: [0], runs: [{ first: 2, length: 2 }], streams: [{ name: 'S', start: 2, size: STREAM_BYTES }] });
    pattern(STREAM_BYTES, 3).copy(file, sectorAt(2));
    return file;
  }

  it('is the declared bytes when the file ends inside the last sector but past the declared end', () => {
    const file = singleStream().subarray(0, sectorAt(3) + TAIL_BYTES + 96);
    const stream = parseCfbf(file).paths.get('S') as Buffer;
    expect(stream.length).toBe(STREAM_BYTES);
    expect(stream.equals(pattern(STREAM_BYTES, 3))).toBe(true);
  });

  it('is refused when the file ends inside the last sector before the declared end, not padded with bytes the file does not hold', () => {
    const held = LARGE_SECTOR_BYTES + TAIL_BYTES - 1;
    const file = singleStream().subarray(0, sectorAt(2) + held);
    expect(() => parseCfbf(file)).toThrow(CorruptStreamError);
    expect(() => parseCfbf(file)).toThrow(`declares ${STREAM_BYTES} bytes but its sector chain holds ${held}`);
  });

  it('claims the sectors the stream declares and no more, so that a stream on the next sectors still parses', () => {
    const sizes = 2 * LARGE_SECTOR_BYTES;
    const file = largeFile({
      sectors: 6,
      directorySector: 1,
      fatSectors: [0],
      runs: [
        { first: 2, length: 2 },
        { first: 4, length: 2 },
      ],
      links: [[3, 4]],
      streams: [
        { name: 'A', start: 2, size: sizes },
        { name: 'B', start: 4, size: sizes },
      ],
    });
    pattern(sizes, 11).copy(file, sectorAt(2));
    pattern(sizes, 29).copy(file, sectorAt(4));
    const parsed = parseCfbf(file);
    expect((parsed.paths.get('A') as Buffer).equals(pattern(sizes, 11))).toBe(true);
    expect((parsed.paths.get('B') as Buffer).equals(pattern(sizes, 29))).toBe(true);
  });
});

describe('a mini stream cutoff in the header that the parser does not read', () => {
  const SECTOR_BYTES = 512;
  const PARSER_CUTOFF = 4096;
  const SECTORS = 40;
  const FAT = 0;
  const DIRECTORY = 1;
  const MINI_FAT = 2;
  const MINI_STREAM_FIRST = 3;
  const MINI_STREAM_SECTORS = 10;
  const REGULAR_FIRST = 13;
  const MINI_SECTORS_IN_USE = 79;
  const STREAM_NAME = 'S';
  const sectorAt = (sector: number): number => (sector + 1) * SECTOR_BYTES;

  /**
   * A version 3 file as a writer with the mini stream cutoff `headerCutoff` lays it out: the FAT at sector 0, the directory at 1,
   * the mini FAT at 2, a mini stream of 79 mini sectors on sectors 3 to 12 and sectors 13 on for the streams of the FAT. The
   * stream `S` has `size` bytes and starts at `start`: a mini sector for a stream below the cutoff, a sector from it up.
   */
  function writtenWithCutoff(headerCutoff: number, size: number, start: number): Buffer {
    const file = Buffer.alloc((SECTORS + 1) * SECTOR_BYTES);
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(file, 0);
    file.writeUInt16LE(0x3e, 24);
    file.writeUInt16LE(3, 26);
    file.writeUInt16LE(0xfffe, 28);
    file.writeUInt16LE(9, 30);
    file.writeUInt16LE(6, 32);
    file.writeUInt32LE(1, 44);
    file.writeUInt32LE(DIRECTORY, 48);
    file.writeUInt32LE(headerCutoff, 56);
    file.writeUInt32LE(MINI_FAT, 60);
    file.writeUInt32LE(1, 64);
    file.writeUInt32LE(END_OF_CHAIN, 68);
    for (let index = 0; index < 109; index++) file.writeUInt32LE(index === 0 ? FAT : FREE_SECTOR, 76 + index * 4);
    const fat = (sector: number, next: number): void => {
      file.writeUInt32LE(next, sectorAt(FAT) + sector * 4);
    };
    for (let sector = 0; sector < SECTOR_BYTES / 4; sector++) fat(sector, FREE_SECTOR);
    fat(FAT, FAT_SECTOR_MARK);
    fat(DIRECTORY, END_OF_CHAIN);
    fat(MINI_FAT, END_OF_CHAIN);
    for (let sector = MINI_STREAM_FIRST; sector < MINI_STREAM_FIRST + MINI_STREAM_SECTORS; sector++) fat(sector, sector + 1 < MINI_STREAM_FIRST + MINI_STREAM_SECTORS ? sector + 1 : END_OF_CHAIN);
    for (let sector = REGULAR_FIRST; sector < SECTORS; sector++) fat(sector, sector + 1 < SECTORS ? sector + 1 : END_OF_CHAIN);
    for (let mini = 0; mini < SECTOR_BYTES / 4; mini++) {
      file.writeUInt32LE(mini + 1 < MINI_SECTORS_IN_USE ? mini + 1 : mini < MINI_SECTORS_IN_USE ? END_OF_CHAIN : FREE_SECTOR, sectorAt(MINI_FAT) + mini * 4);
    }
    const entry = (at: number, name: string, type: number, child: number, first: number, bytes: number): void => {
      file.write(name, at, 'utf16le');
      file.writeUInt16LE((name.length + 1) * 2, at + 64);
      file.writeUInt8(type, at + 66);
      file.writeUInt32LE(FREE_SECTOR, at + 68);
      file.writeUInt32LE(FREE_SECTOR, at + 72);
      file.writeUInt32LE(child, at + 76);
      file.writeUInt32LE(first, at + 116);
      file.writeUInt32LE(bytes, at + 120);
    };
    entry(sectorAt(DIRECTORY), 'Root Entry', 5, 1, MINI_STREAM_FIRST, MINI_STREAM_SECTORS * SECTOR_BYTES);
    entry(sectorAt(DIRECTORY) + 128, STREAM_NAME, 2, FREE_SECTOR, start, size);
    file.fill(0x41, sectorAt(MINI_STREAM_FIRST), sectorAt(MINI_STREAM_FIRST + MINI_STREAM_SECTORS));
    file.fill(0x5a, sectorAt(REGULAR_FIRST));
    return file;
  }

  it('leaves a file that the cutoff of 4096 agrees with as it was', () => {
    const regular = parseCfbf(writtenWithCutoff(PARSER_CUTOFF, 5000, REGULAR_FIRST)).paths.get(STREAM_NAME) as Buffer;
    expect(regular).toEqual(Buffer.alloc(5000, 0x5a));
    const mini = parseCfbf(writtenWithCutoff(PARSER_CUTOFF, 3000, 0)).paths.get(STREAM_NAME) as Buffer;
    expect(mini).toEqual(Buffer.alloc(3000, 0x41));
  });

  it('refuses the stream of a writer with a cutoff of 8192, which lives in the mini stream where this parser looks in the sectors', () => {
    const file = writtenWithCutoff(8192, 5000, 0);
    expect(() => parseCfbf(file)).toThrow(CorruptStreamError);
    expect(() => parseCfbf(file)).toThrow(/its header gives the mini stream cutoff 8192, so its stream "S" of 5000 bytes is stored in the other store/);
  });

  it('would otherwise return the bytes of sectors no chain of the stream owns', () => {
    const crafted = writtenWithCutoff(8192, 5000, REGULAR_FIRST);
    expect(() => parseCfbf(crafted)).toThrow(/mini stream cutoff 8192/);
    crafted.writeUInt32LE(PARSER_CUTOFF, 56);
    expect(parseCfbf(crafted).paths.get(STREAM_NAME)).toEqual(Buffer.alloc(5000, 0x5a));
  });

  it.each([
    [8192, 4095, 'ok'],
    [8192, 4096, 'refused'],
    [8192, 8191, 'refused'],
    [8192, 8192, 'ok'],
    [512, 511, 'ok'],
    [512, 512, 'refused'],
    [512, 4095, 'refused'],
    [512, 4096, 'ok'],
    [0, 300, 'refused'],
  ])('refuses a stream between the header cutoff %i and 4096 and no other: %i bytes is %s', (headerCutoff, size, outcome) => {
    const start = size < PARSER_CUTOFF ? 0 : REGULAR_FIRST;
    const file = writtenWithCutoff(headerCutoff, size, start);
    if (outcome === 'ok') expect(parseCfbf(file).paths.get(STREAM_NAME)?.length).toBe(size);
    else expect(() => parseCfbf(file)).toThrow(/its header gives the mini stream cutoff/);
  });

  it('leaves unchecked a stream of no bytes, which lies in neither store', () => {
    const file = writtenWithCutoff(8192, 0, 0);
    expect(parseCfbf(file).directoryEntries.map((entry) => entry.name)).toEqual(['Root Entry', STREAM_NAME]);
  });
});
