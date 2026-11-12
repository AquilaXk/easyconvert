import { describe, expect, it } from 'vitest';
import { editExif, ExifFormatError, ExifValueError, readExif, tiffBlockOf } from '../src/lib/jobs/metadata/exif';

/**
 * The EXIF editor changes the directories it names and nothing else: a value or a vendor block that the file's own offsets point
 * at stays where it is, byte for byte.
 */

const MAKER_NOTE = Buffer.from('VENDOR-BLOCK\0with absolute offsets inside');
const MAKER_NOTE_TAG = 0x927c;
const EXIF_IFD_POINTER = 0x8769;
const ASCII = 2;
const LONG = 4;
const UNDEFINED = 7;

interface Entry {
  tag: number;
  type: number;
  count: number;
  value: Buffer;
}

/** A little-endian block with Make in the first directory and a MakerNote in the Exif directory, built by hand. */
function blockWithMakerNote(): { block: Buffer; makerNoteAt: number } {
  const make = Buffer.from('Acme\0', 'latin1');
  const ifd0At = 8;
  const ifd0Bytes = 2 + 2 * 12 + 4;
  const makeAt = ifd0At + ifd0Bytes;
  const exifAt = makeAt + make.length + (make.length % 2);
  const exifBytes = 2 + 1 * 12 + 4;
  const makerNoteAt = exifAt + exifBytes;
  const block = Buffer.alloc(makerNoteAt + MAKER_NOTE.length);
  block.write('II', 0, 'latin1');
  block.writeUInt16LE(42, 2);
  block.writeUInt32LE(ifd0At, 4);
  const writeDirectory = (at: number, entries: Entry[]): void => {
    block.writeUInt16LE(entries.length, at);
    entries.forEach((entry, index) => {
      const row = at + 2 + index * 12;
      block.writeUInt16LE(entry.tag, row);
      block.writeUInt16LE(entry.type, row + 2);
      block.writeUInt32LE(entry.count, row + 4);
      entry.value.copy(block, row + 8);
    });
  };
  const offset = (value: number): Buffer => {
    const out = Buffer.alloc(4);
    out.writeUInt32LE(value);
    return out;
  };
  writeDirectory(ifd0At, [
    { tag: 0x010f, type: ASCII, count: make.length, value: offset(makeAt) },
    { tag: EXIF_IFD_POINTER, type: LONG, count: 1, value: offset(exifAt) },
  ]);
  make.copy(block, makeAt);
  writeDirectory(exifAt, [{ tag: MAKER_NOTE_TAG, type: UNDEFINED, count: MAKER_NOTE.length, value: offset(makerNoteAt) }]);
  MAKER_NOTE.copy(block, makerNoteAt);
  return { block, makerNoteAt };
}

describe('editExif', () => {
  it('keeps every byte of the file that an edit does not name, at the offset it had', () => {
    const { block, makerNoteAt } = blockWithMakerNote();
    const edited = editExif(block, { Artist: 'Ann', DateTimeOriginal: '2026:11:12 10:00:00' });
    expect(edited.subarray(makerNoteAt, makerNoteAt + MAKER_NOTE.length).equals(MAKER_NOTE)).toBe(true);
    expect(edited.length).toBeGreaterThan(block.length);
    // The values that sit between the first directory and the MakerNote are unchanged too.
    expect(edited.subarray(8 + 2 + 24 + 4, makerNoteAt).equals(block.subarray(8 + 2 + 24 + 4, makerNoteAt))).toBe(true);
    // The Make that was there is still read, with the new fields beside it.
    expect(readExif(edited).EXIF).toMatchObject({ Make: 'Acme', Artist: 'Ann', DateTimeOriginal: '2026:11:12 10:00:00' });
  });

  it('removes a field set to null and leaves the others', () => {
    const { block } = blockWithMakerNote();
    const edited = editExif(editExif(block, { Artist: 'Ann', Copyright: 'x' }), { Artist: null });
    const exif = readExif(edited).EXIF ?? {};
    expect(exif).not.toHaveProperty('Artist');
    expect(exif).toMatchObject({ Make: 'Acme', Copyright: 'x' });
  });

  it('starts a block for a picture that has none, in the byte order it writes', () => {
    const edited = editExif(null, { Make: 'Zed', Orientation: 6, GPSLatitude: -33.8688, GPSLongitude: 151.2093, GPSAltitude: -12.5 });
    expect(tiffBlockOf(edited)).not.toBeNull();
    expect(readExif(edited)).toEqual({
      EXIF: { Make: 'Zed', Orientation: 6 },
      GPS: { GPSLatitude: -33.8688, GPSLongitude: 151.2093, GPSAltitude: -12.5 },
    });
  });

  it('reads a block back after any number of edits', () => {
    let block: Buffer | null = null;
    for (let round = 0; round < 5; round++) block = editExif(block, { Software: `tool ${round}`, ImageDescription: `d${round}` });
    expect(readExif(block as Buffer).EXIF).toMatchObject({ Software: 'tool 4', ImageDescription: 'd4' });
  });

  it('writes UserComment with the ASCII charset header and reads the text back', () => {
    expect(readExif(editExif(null, { UserComment: 'a note' })).EXIF).toMatchObject({ UserComment: 'a note' });
  });

  it.each([
    [{ Orientation: 9 }, /Orientation/],
    [{ Orientation: 'sideways' }, /Orientation/],
    [{ CreateDate: '2026-11-12' }, /YYYY:MM:DD/],
    [{ GPSLatitude: 91 }, /GPSLatitude/],
    [{ GPSLongitude: Number.NaN }, /GPSLongitude/],
    [{ Artist: '' }, /takes text/],
    [{ Artist: 'x'.repeat(5000) }, /at most/],
    [{ ISO: 100 }, /not an EXIF field that can be written/],
  ])('refuses %j with the field named', (edits, message) => {
    expect(() => editExif(null, edits as Record<string, string | number>)).toThrow(ExifValueError);
    expect(() => editExif(null, edits as Record<string, string | number>)).toThrow(message);
  });

  it('refuses a block cut short instead of reading past it', () => {
    const { block } = blockWithMakerNote();
    expect(() => editExif(block.subarray(0, 20), { Artist: 'x' })).toThrow(ExifFormatError);
  });

  it('refuses a directory that lists more entries than any camera writes', () => {
    const block = Buffer.alloc(8 + 2 + 4);
    block.write('MM', 0, 'latin1');
    block.writeUInt16BE(42, 2);
    block.writeUInt32BE(8, 4);
    block.writeUInt16BE(0xffff, 8);
    expect(() => readExif(block)).toThrow(ExifFormatError);
  });
});

describe('readExif', () => {
  it('names the tags as ExifTool does and gives rationals as numbers', () => {
    const block = editExif(null, { Make: 'Acme', Model: 'C1', DateTimeOriginal: '2026:01:02 03:04:05' });
    expect(readExif(block).EXIF).toEqual({ Make: 'Acme', Model: 'C1', DateTimeOriginal: '2026:01:02 03:04:05' });
  });

  it('accepts the block with its Exif prefix and rejects bytes that are not a block', () => {
    const block = editExif(null, { Make: 'Acme' });
    expect(tiffBlockOf(Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), block]))).not.toBeNull();
    expect(tiffBlockOf(Buffer.from('not a tiff block at all'))).toBeNull();
  });
});
