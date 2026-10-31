import { describe, expect, it } from 'vitest';
import { buildCfbfContainer } from '../src/lib/conversions/cfbf-writer';
import { parseCfbf } from '../src/lib/conversions/cfbf-reader';
import { convertXlsSource } from '../src/lib/conversions/office';
import { readCfbContainer } from '../src/lib/conversions/office/cfb-streams';
import { isEncryptedWordDocument } from '../src/lib/conversions/office/doc-reader';
import { LegacyOfficeFormatError } from '../src/lib/conversions/office/legacy-office-errors';
import { CompoundFileStructureError, CorruptStreamError } from '../src/lib/types';
import { entryFields, entryId, miniFatSectors, setEntry, setFatEntry } from './helpers/cfbf-layout';

/**
 * One cause for a destroyed table of contents. A compound file keeps where its streams are in three chains (the directory, the mini
 * FAT and the root entry's mini stream) and in the lists of its FAT sectors. When a chain runs out of the file or the FAT, ends on
 * a marker that is not the end of the chain, loops, shares a sector with the FAT or another chain, when the FAT list or the DIFAT
 * chain names a sector twice, or the directory is empty or over-full, the file cannot be read by anyone, so the parser refuses it
 * with a `CompoundFileStructureError` wherever the bad number lands. The readers of legacy documents refuse it as a
 * `LegacyOfficeFormatError` with that error as the cause, and the office suite is not asked to write its bytes as text. A stream
 * cut short stays the stream's own `CorruptStreamError`.
 */

const SECTOR_BYTES = 512;
const FIRST_DIRECTORY_SECTOR_OFFSET = 48;
const FIRST_MINI_FAT_SECTOR_OFFSET = 60;
const MINI_FAT_SECTOR_COUNT_OFFSET = 64;
const HEADER_FAT_LIST_OFFSET = 76;
const ENTRY_NAME_LENGTH_OFFSET = 64;
const ENTRY_BYTES = 128;
const BEYOND_THE_FILE = 0x7ffffff0;
/** A sector that the padded file holds and its FAT covers, and no chain uses. */
const UNUSED_SECTOR = 100;
const END_OF_CHAIN = 0xfffffffe;
const FAT_SECTOR_MARK = 0xfffffffd;
const DIFAT_SECTOR_MARK = 0xfffffffc;
const FREE_SECTOR = 0xffffffff;
const SMALL_STREAM_BYTES = 300;
const LARGE_STREAM_BYTES = 16 * 1024;
const MINI_STREAM_NEEDING_TWO_MINI_FAT_SECTORS_BYTES = 3000;
const HTTP_BAD_REQUEST = 400;
const ROOT_ENTRY_ID = 0;

const filled = (size: number, byte: number): Buffer => Buffer.alloc(size, byte);
const streams = (...sizes: number[]): Buffer =>
  buildCfbfContainer(sizes.map((size, index) => ({ name: String.fromCharCode(65 + index), data: filled(size, 0x41 + index) })));
/** A small stream (in the mini stream) and a large one (in the sectors of the file). */
const smallAndLarge = (): Buffer => streams(SMALL_STREAM_BYTES, LARGE_STREAM_BYTES);
/** Three streams whose mini stream has more mini sectors than one sector of the mini FAT holds. */
const needingTwoMiniFatSectors = (): Buffer => streams(...Array.from({ length: 3 }, () => MINI_STREAM_NEEDING_TWO_MINI_FAT_SECTORS_BYTES));
const rootStart = (file: Buffer): number => entryFields(file, ROOT_ENTRY_ID).start;

const directoryStart = (file: Buffer): number => file.readUInt32LE(FIRST_DIRECTORY_SECTOR_OFFSET);
const miniFatStart = (file: Buffer): number => file.readUInt32LE(FIRST_MINI_FAT_SECTOR_OFFSET);
const startOf = (file: Buffer, name: string): number => entryFields(file, entryId(file, name)).start;

const refusalOf = (file: Buffer): unknown => {
  try {
    parseCfbf(file);
  } catch (error) {
    return error;
  }
  return undefined;
};

function expectStructureRefusal(file: Buffer, reason: RegExp): void {
  const refusal = refusalOf(file);
  expect(refusal).toBeInstanceOf(CompoundFileStructureError);
  expect((refusal as CompoundFileStructureError).name).toBe('CompoundFileStructureError');
  expect((refusal as CompoundFileStructureError).status).toBe(HTTP_BAD_REQUEST);
  expect((refusal as Error).message).toMatch(reason);
}

describe('the directory chain', () => {
  const paddedFile = (): Buffer => Buffer.concat([smallAndLarge(), Buffer.alloc((SECTOR_BYTES / 4) * SECTOR_BYTES)]);

  it('is read by a file whose directory chain is whole', () => {
    expect([...parseCfbf(smallAndLarge()).paths.keys()]).toEqual(['A', 'B']);
  });

  it.each([
    ['a sector past the file', (file: Buffer) => setFatEntry(file, directoryStart(file), BEYOND_THE_FILE), /reaches sector \d+, which the file does not hold/],
    ['a sector the FAT does not cover', (file: Buffer) => setFatEntry(file, directoryStart(file), SECTOR_BYTES / 4 + 1), /ends at sector \d+, which the FAT does not cover/],
    ['a sector of the FAT', (file: Buffer) => setFatEntry(file, directoryStart(file), file.readUInt32LE(HEADER_FAT_LIST_OFFSET)), /which holds the FAT or the DIFAT/],
    ['a sector of another chain', (file: Buffer) => setFatEntry(file, directoryStart(file), startOf(file, 'B')), /belongs to two chains/],
    ['its own sector', (file: Buffer) => setFatEntry(file, directoryStart(file), directoryStart(file)), /returns to sector/],
    ['a free sector', (file: Buffer) => setFatEntry(file, directoryStart(file), UNUSED_SECTOR), /ends at the marker 0xffffffff, not at the end of the chain/],
    ['the free marker', (file: Buffer) => setFatEntry(file, directoryStart(file), FREE_SECTOR), /ends at the marker 0xffffffff, not at the end of the chain/],
    ['the FAT marker', (file: Buffer) => setFatEntry(file, directoryStart(file), FAT_SECTOR_MARK), /ends at the marker 0xfffffffd, not at the end of the chain/],
    ['the DIFAT marker', (file: Buffer) => setFatEntry(file, directoryStart(file), DIFAT_SECTOR_MARK), /ends at the marker 0xfffffffc, not at the end of the chain/],
  ])('is refused as a destroyed structure when it runs to %s', (_, damage, reason) => {
    const file = paddedFile();
    damage(file);
    expectStructureRefusal(file, reason);
  });

  it.each([
    ['the end-of-chain marker', END_OF_CHAIN],
    ['the free marker', FREE_SECTOR],
    ['the FAT marker', FAT_SECTOR_MARK],
  ])('is refused as a destroyed structure when it starts at %s, which is an empty directory', (_, start) => {
    const file = smallAndLarge();
    file.writeUInt32LE(start, FIRST_DIRECTORY_SECTOR_OFFSET);
    expectStructureRefusal(file, /the sector chain starts at the marker 0x[0-9a-f]+, not at a sector/);
  });

  it('is refused as a destroyed structure when no entry of it has a name', () => {
    const file = smallAndLarge();
    const first = (directoryStart(file) + 1) * SECTOR_BYTES;
    for (let slot = 0; slot < SECTOR_BYTES / ENTRY_BYTES; slot++) file.writeUInt16LE(0, first + slot * ENTRY_BYTES + ENTRY_NAME_LENGTH_OFFSET);
    expectStructureRefusal(file, /its directory holds no entry/);
  });
});

describe('the mini FAT chain', () => {
  it('is read by a file whose mini FAT chain is whole', () => {
    expect(parseCfbf(needingTwoMiniFatSectors()).paths.get('C')).toEqual(filled(MINI_STREAM_NEEDING_TWO_MINI_FAT_SECTORS_BYTES, 0x43));
  });

  it.each([
    ['a sector past the file', (file: Buffer) => setFatEntry(file, miniFatStart(file), BEYOND_THE_FILE), /reaches sector \d+, which the file does not hold/],
    ['a sector of the FAT', (file: Buffer) => setFatEntry(file, miniFatStart(file), file.readUInt32LE(HEADER_FAT_LIST_OFFSET)), /which holds the FAT or the DIFAT/],
    ['its own sector', (file: Buffer) => setFatEntry(file, miniFatStart(file), miniFatStart(file)), /returns to sector/],
    ['the free marker', (file: Buffer) => setFatEntry(file, miniFatStart(file), FREE_SECTOR), /ends at the marker 0xffffffff, not at the end of the chain/],
    ['the directory', (file: Buffer) => setFatEntry(file, miniFatStart(file), directoryStart(file)), /belongs to two chains/],
  ])('is refused as a destroyed structure when it runs to %s', (_, damage, reason) => {
    const file = needingTwoMiniFatSectors();
    file.writeUInt32LE(2, MINI_FAT_SECTOR_COUNT_OFFSET);
    damage(file);
    expectStructureRefusal(file, reason);
  });

  it('is refused as a destroyed structure when a stream starts on a sector of it', () => {
    const file = streams(SMALL_STREAM_BYTES, LARGE_STREAM_BYTES);
    setEntry(file, entryId(file, 'B'), { start: miniFatStart(file) });
    expectStructureRefusal(file, /belongs to two chains/);
  });

  it('is refused as a destroyed structure when a chain of one sector ends on a free sector', () => {
    const file = smallAndLarge();
    expect(file.readUInt32LE(MINI_FAT_SECTOR_COUNT_OFFSET)).toBe(1);
    setFatEntry(file, miniFatStart(file), FREE_SECTOR);
    expectStructureRefusal(file, /ends at the marker 0xffffffff, not at the end of the chain/);
  });

  it('is claimed to its end, so that a stream on a sector of it past the entries the mini stream addresses is refused', () => {
    const padded = Buffer.concat([streams(...Array.from({ length: 3 }, () => MINI_STREAM_NEEDING_TWO_MINI_FAT_SECTORS_BYTES), LARGE_STREAM_BYTES), Buffer.alloc((SECTOR_BYTES / 4) * SECTOR_BYTES)]);
    const [, second] = miniFatSectors(padded);
    setFatEntry(padded, second, UNUSED_SECTOR);
    setFatEntry(padded, UNUSED_SECTOR, END_OF_CHAIN);
    setEntry(padded, entryId(padded, 'D'), { start: UNUSED_SECTOR });
    expectStructureRefusal(padded, /belongs to two chains/);
  });

  it.each([
    ['the end-of-chain marker', END_OF_CHAIN],
    ['the free marker', FREE_SECTOR],
  ])('is refused as a destroyed structure when the header counts sectors of it and it starts at %s', (_, start) => {
    const file = smallAndLarge();
    file.writeUInt32LE(start, FIRST_MINI_FAT_SECTOR_OFFSET);
    expect(file.readUInt32LE(MINI_FAT_SECTOR_COUNT_OFFSET)).toBe(1);
    expectStructureRefusal(file, /the sector chain starts at the marker 0x[0-9a-f]+, not at a sector/);
  });

  it('is not read at all when there is no mini stream, so nothing the header says of it is a fault', () => {
    const file = streams(LARGE_STREAM_BYTES);
    expect(file.readUInt32LE(MINI_FAT_SECTOR_COUNT_OFFSET)).toBe(0);
    file.writeUInt32LE(0xffffffff, MINI_FAT_SECTOR_COUNT_OFFSET);
    file.writeUInt32LE(BEYOND_THE_FILE, FIRST_MINI_FAT_SECTOR_OFFSET);
    expect(parseCfbf(file).paths.get('A')).toEqual(filled(LARGE_STREAM_BYTES, 0x41));
  });
});

describe('the mini stream chain of the root entry', () => {
  it('is read by a file whose root chain is whole', () => {
    expect(parseCfbf(needingTwoMiniFatSectors()).paths.get('A')).toEqual(filled(MINI_STREAM_NEEDING_TWO_MINI_FAT_SECTORS_BYTES, 0x41));
  });

  it.each([
    ['a sector past the file', (file: Buffer) => setFatEntry(file, rootStart(file) + 1, BEYOND_THE_FILE), /reaches sector \d+, which the file does not hold/],
    ['its own first sector', (file: Buffer) => setFatEntry(file, rootStart(file) + 1, rootStart(file)), /returns to sector/],
    ['the free marker', (file: Buffer) => setFatEntry(file, rootStart(file) + 1, FREE_SECTOR), /ends at the marker 0xffffffff, not at the end of the chain/],
    ['the first sector of a large stream', (file: Buffer) => setFatEntry(file, rootStart(file) + 1, startOf(file, 'D')), /belongs to two chains/],
    ['the directory', (file: Buffer) => setFatEntry(file, rootStart(file) + 1, directoryStart(file)), /belongs to two chains/],
  ])('is refused as a destroyed structure when it runs to %s', (_, damage, reason) => {
    const file = streams(...Array.from({ length: 3 }, () => MINI_STREAM_NEEDING_TWO_MINI_FAT_SECTORS_BYTES), LARGE_STREAM_BYTES);
    damage(file);
    expectStructureRefusal(file, reason);
  });

  it('is refused as a destroyed structure when a stream starts on a sector of it', () => {
    const file = smallAndLarge();
    setEntry(file, entryId(file, 'B'), { start: rootStart(file) });
    expectStructureRefusal(file, /belongs to two chains/);
  });

  it('is not read when no stream lies below the cutoff, whatever the root entry says of a mini stream', () => {
    const file = streams(LARGE_STREAM_BYTES);
    setEntry(file, ROOT_ENTRY_ID, { start: BEYOND_THE_FILE, size: SMALL_STREAM_BYTES });
    expect(parseCfbf(file).paths.get('A')).toEqual(filled(LARGE_STREAM_BYTES, 0x41));
  });
});

describe('the chains of the streams', () => {
  it.each([
    ['starts on the FAT', (file: Buffer) => setEntry(file, entryId(file, 'B'), { start: file.readUInt32LE(HEADER_FAT_LIST_OFFSET) }), /which holds the FAT or the DIFAT/],
    ['returns to itself', (file: Buffer) => setFatEntry(file, startOf(file, 'B'), startOf(file, 'B')), /returns to sector/],
    ['runs past the FAT', (file: Buffer) => setFatEntry(file, startOf(file, 'B') + 3, BEYOND_THE_FILE), /declares \d+ bytes but its sector chain holds/],
  ])('stay a stream\'s own corruption when a chain %s', (_, damage, reason) => {
    const file = smallAndLarge();
    damage(file);
    const refusal = refusalOf(file);
    expect(refusal).toBeInstanceOf(CorruptStreamError);
    expect(refusal).not.toBeInstanceOf(CompoundFileStructureError);
    expect((refusal as Error).message).toMatch(reason);
  });

  it('stay a stream\'s own corruption when two streams share a sector', () => {
    const file = streams(LARGE_STREAM_BYTES, LARGE_STREAM_BYTES);
    setEntry(file, entryId(file, 'B'), { start: startOf(file, 'A') });
    const refusal = refusalOf(file);
    expect(refusal).toBeInstanceOf(CorruptStreamError);
    expect(refusal).not.toBeInstanceOf(CompoundFileStructureError);
    expect((refusal as Error).message).toBe(`Corrupt CFBF container: sector ${startOf(file, 'A')} belongs to two chains.`);
  });
});

describe('the readers of legacy documents', () => {
  const destroyed = (): Buffer => {
    const file = smallAndLarge();
    setFatEntry(file, directoryStart(file), BEYOND_THE_FILE);
    return file;
  };

  const readingRefusal = (file: Buffer): unknown => {
    try {
      readCfbContainer(file, 'PowerPoint presentation');
    } catch (error) {
      return error;
    }
    return undefined;
  };

  it('refuse a destroyed structure as a legacy document format error with the label of the document, and keep the cause', () => {
    const refusal = readingRefusal(destroyed());
    expect(refusal).toBeInstanceOf(LegacyOfficeFormatError);
    expect((refusal as LegacyOfficeFormatError).message).toMatch(/^PowerPoint presentation: the compound file is malformed \(Corrupt CFBF container: the sector chain starting at sector \d+ reaches sector \d+, which the file does not hold\.\)\.$/);
    expect((refusal as LegacyOfficeFormatError).cause).toBeInstanceOf(CompoundFileStructureError);
  });

  it('refuse the damage of a stream as a legacy document format error whose cause is not a destroyed structure', () => {
    const file = smallAndLarge();
    setFatEntry(file, startOf(file, 'B'), startOf(file, 'B'));
    const refusal = readingRefusal(file);
    expect(refusal).toBeInstanceOf(LegacyOfficeFormatError);
    expect((refusal as LegacyOfficeFormatError).cause).toBeInstanceOf(CorruptStreamError);
    expect((refusal as LegacyOfficeFormatError).cause).not.toBeInstanceOf(CompoundFileStructureError);
    expect((refusal as LegacyOfficeFormatError).message).toMatch(/^PowerPoint presentation: the compound file is malformed \(Corrupt CFBF container: .*returns to sector \d+\.\)\.$/);
  });

  it('refuse a workbook of it as itself, not as a missing Workbook stream', async () => {
    const refusal = await convertXlsSource(destroyed(), 'csv', {}, 'damaged').catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(CompoundFileStructureError);
    expect((refusal as Error).message).toMatch(/^Corrupt CFBF container: the sector chain starting at sector \d+ reaches sector \d+, which the file does not hold\.$/);
  });

  it('are not asked whether a document of it is encrypted: it is not a Word binary as far as they can tell', () => {
    expect(isEncryptedWordDocument(destroyed())).toBe(false);
  });
});
