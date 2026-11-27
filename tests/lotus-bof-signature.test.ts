import { describe, expect, it } from 'vitest';
import { assertNotSpoofedFile, FileExtensionSpoofError } from '../src/lib/registry';

/**
 * The BOF record of a Lotus 1-2-3 file: opcode 0, then the record length, then the revision. Release 1 and 2 files carry a 2 byte
 * record (revision 0x0404 and up); release 3 and later (`.wk3`, `.wk4`) carry a 0x1A byte record whose revision is 0x1000..0x1005. A check
 * that wanted a length of 2 for both could never see the second kind.
 */
function bof(length: number, revision: number): Buffer {
  const buf = Buffer.alloc(4 + Math.max(length, 2));
  buf.writeUInt16LE(length, 2);
  buf.writeUInt16LE(revision, 4);
  return buf;
}

const sniff = (buf: Buffer) => assertNotSpoofedFile(buf, 'wks', 'sheet.wks');

describe('Lotus 1-2-3 BOF signature', () => {
  it.each([0x0404, 0x0406, 0x0408, 0x0008])('accepts a release 1 or 2 record of revision %d', (revision) => {
    expect(() => sniff(bof(2, revision))).not.toThrow();
  });

  it.each([0x1000, 0x1002, 0x1003, 0x1005])('accepts a release 3 and later record of 0x1A bytes, revision %d', (revision) => {
    expect(() => sniff(bof(0x1a, revision))).not.toThrow();
  });

  it('refuses a release 3 revision behind a 2 byte record and a release 1 revision behind a 0x1A byte record', () => {
    expect(() => sniff(bof(2, 0x1000))).toThrow(FileExtensionSpoofError);
    expect(() => sniff(bof(0x1a, 0x0404))).toThrow(FileExtensionSpoofError);
  });

  it('refuses a revision outside both ranges', () => {
    expect(() => sniff(bof(0x1a, 0x1006))).toThrow(FileExtensionSpoofError);
    expect(() => sniff(bof(2, 0x0410))).toThrow(FileExtensionSpoofError);
  });
});
