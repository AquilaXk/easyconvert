import { describe, expect, it } from 'vitest';
import { emfViolations, wmfViolations } from '../bench/metafile-check';

/**
 * The metafile reader of the benchmark is written from [MS-EMF] and [MS-WMF]. These files are built byte by byte from the
 * layouts in the specifications (not by any converter), so what the reader accepts and refuses is pinned independently of
 * the engines whose output it judges.
 */

/** A well-formed EMF: the 88-byte header, one EMR_RECTANGLE record and EMR_EOF. */
function emf(overrides: { bytes?: number; records?: number; signature?: number; frame?: [number, number, number, number]; eofType?: number } = {}): Buffer {
  const header = Buffer.alloc(88);
  header.writeUInt32LE(1, 0);
  header.writeUInt32LE(88, 4);
  const frame = overrides.frame ?? [0, 0, 1000, 800];
  frame.forEach((value, i) => header.writeInt32LE(value, 24 + i * 4));
  header.writeUInt32LE(overrides.signature ?? 0x464d4520, 40);
  header.writeUInt32LE(0x10000, 44);
  const rectangle = Buffer.alloc(24);
  rectangle.writeUInt32LE(43, 0);
  rectangle.writeUInt32LE(24, 4);
  const eof = Buffer.alloc(20);
  eof.writeUInt32LE(overrides.eofType ?? 14, 0);
  eof.writeUInt32LE(20, 4);
  eof.writeUInt32LE(16, 12);
  eof.writeUInt32LE(20, 16);
  const file = Buffer.concat([header, rectangle, eof]);
  file.writeUInt32LE(overrides.bytes ?? file.length, 48);
  file.writeUInt32LE(overrides.records ?? 3, 52);
  return file;
}

/** A well-formed placeable WMF: placeable header, METAHEADER, one META_RECTANGLE record and the end record. */
function wmf(overrides: { checksum?: number; sizeWords?: number; maxRecord?: number; version?: number; eofFunction?: number } = {}): Buffer {
  const placeable = Buffer.alloc(22);
  placeable.writeUInt32LE(0x9ac6cdd7, 0);
  placeable.writeInt16LE(0, 6);
  placeable.writeInt16LE(0, 8);
  placeable.writeInt16LE(400, 10);
  placeable.writeInt16LE(300, 12);
  placeable.writeUInt16LE(96, 14);
  let checksum = 0;
  for (let at = 0; at < 20; at += 2) checksum ^= placeable.readUInt16LE(at);
  placeable.writeUInt16LE(overrides.checksum ?? checksum, 20);
  const header = Buffer.alloc(18);
  header.writeUInt16LE(1, 0);
  header.writeUInt16LE(9, 2);
  header.writeUInt16LE(overrides.version ?? 0x0300, 4);
  const rectangle = Buffer.alloc(14);
  rectangle.writeUInt32LE(7, 0);
  rectangle.writeUInt16LE(0x041b, 4);
  const eof = Buffer.alloc(6);
  eof.writeUInt32LE(3, 0);
  eof.writeUInt16LE(overrides.eofFunction ?? 0, 4);
  const body = Buffer.concat([header, rectangle, eof]);
  body.writeUInt32LE(overrides.sizeWords ?? body.length / 2, 6);
  body.writeUInt32LE(overrides.maxRecord ?? 7, 12);
  return Buffer.concat([placeable, body]);
}

describe('emfViolations', () => {
  it('accepts a well-formed enhanced metafile', () => {
    expect(emfViolations(emf())).toEqual([]);
  });

  it.each<[string, Buffer, string]>([
    ['a signature that is not " EMF"', emf({ signature: 0x12345678 }), 'header signature is not " EMF"'],
    ['a byte count that is not the file size', emf({ bytes: 200 }), 'header says 200 bytes, file has 132'],
    ['a record count that is not the number of records', emf({ records: 4 }), 'header says 4 records, file has 3'],
    ['a last record that is not EMR_EOF', emf({ eofType: 43 }), 'last record is not EMR_EOF'],
    ['a frame without area', emf({ frame: [0, 0, 0, 800] }), 'header frame has no area'],
    ['a file shorter than the header', Buffer.alloc(40), 'shorter than the 88 byte header'],
  ])('lists %s', (_name, file, message) => {
    expect(emfViolations(file)).toContain(message);
  });

  it('lists a record whose size runs past the end of the file', () => {
    const file = emf();
    file.writeUInt32LE(4000, 88 + 4);
    expect(emfViolations(file).some((line) => line.startsWith('record 1 at byte 88 has size 4000'))).toBe(true);
  });
});

describe('wmfViolations', () => {
  it('accepts a well-formed placeable metafile', () => {
    expect(wmfViolations(wmf())).toEqual([]);
  });

  it.each<[string, Buffer, string]>([
    ['a wrong placeable checksum', wmf({ checksum: 1234 }), 'placeable header checksum is wrong'],
    ['a size that is not the file size', wmf({ sizeWords: 99 }), 'header says 198 bytes, file has 38'],
    ['a version that is neither 0x0100 nor 0x0300', wmf({ version: 0x0200 }), 'header version is neither 0x0100 nor 0x0300'],
    ['a last record that is not the end record', wmf({ eofFunction: 0x041b }), 'last record is not the end-of-file record'],
    ['a largest-record size that is not the largest', wmf({ maxRecord: 5 }), 'header says the largest record is 5 words, the largest is 7'],
  ])('lists %s', (_name, file, message) => {
    expect(wmfViolations(file)).toContain(message);
  });
});
