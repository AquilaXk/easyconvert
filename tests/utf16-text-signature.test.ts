import { describe, expect, it } from 'vitest';
import { isUtf16LeText, looksUcs16LittleEndian } from '../src/lib/utf16-text-signature';

/**
 * `looks_ucs16` of libmagic (file/file `src/encoding.c` at commit bbffb78dc8d764a707aa20f5c7a3b74c40c2b27c), for the little-endian mark. The
 * expected answers are read from that function and from its `text_chars` table; `file -b --mime-encoding` of file 5.41 agrees on the
 * control characters, U+FFFE and DEL (it is older than the commit and takes a lone surrogate and a noncharacter for text).
 */

const BOM = [0xff, 0xfe];
const units = (...codeUnits: number[]): Buffer => Buffer.from([...BOM, ...codeUnits.flatMap((unit) => [unit & 0xff, unit >> 8])]);

describe('looksUcs16LittleEndian', () => {
  it('takes text behind the mark', () => {
    expect(looksUcs16LittleEndian(Buffer.concat([Buffer.from(BOM), Buffer.from('a,b\r\n1,2\r\n', 'utf16le')]))).toBe(true);
    expect(looksUcs16LittleEndian(Buffer.concat([Buffer.from(BOM), Buffer.from('이름,나이 🎉\n', 'utf16le')]))).toBe(true);
  });

  it('takes the mark alone, and a text cut inside a code unit or between the halves of a pair', () => {
    expect(looksUcs16LittleEndian(Buffer.from(BOM))).toBe(true);
    expect(looksUcs16LittleEndian(Buffer.from([...BOM, 0x41]))).toBe(true);
    expect(looksUcs16LittleEndian(units(0x41, 0xd83c))).toBe(true);
  });

  it('refuses a buffer without the little-endian mark', () => {
    expect(looksUcs16LittleEndian(Buffer.from([0xfe, 0xff, 0x00, 0x41]))).toBe(false);
    expect(looksUcs16LittleEndian(Buffer.from([0xff]))).toBe(false);
    expect(looksUcs16LittleEndian(Buffer.from('plain'))).toBe(false);
  });

  it.each([
    ['U+FFFE', units(0xfffe)],
    ['U+FFFF', units(0xffff)],
    ['the first noncharacter', units(0xfdd0)],
    ['the last noncharacter', units(0xfdef)],
    ['a low surrogate with no high one', units(0xdc00)],
    ['a high surrogate followed by text', units(0xd800, 0x41)],
    ['a high surrogate followed by a high one', units(0xd800, 0xd800)],
    ['SOH', units(0x01)],
    ['DEL', units(0x7f)],
    ['a control below SPACE that text does not hold', units(0x1c)],
  ])('refuses %s', (_label, bytes) => {
    expect(looksUcs16LittleEndian(bytes)).toBe(false);
  });

  it.each([0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x1a, 0x1b, 0x20, 0x7e, 0x80, 0xfdcf, 0xfdf0, 0xfffd])('takes the code unit %i', (unit) => {
    expect(looksUcs16LittleEndian(units(unit))).toBe(true);
  });

  it('takes U+0000, which libmagic leaves to the caller', () => {
    expect(looksUcs16LittleEndian(units(0x00, 0x41))).toBe(true);
  });

  it('takes a pair of surrogates', () => {
    expect(looksUcs16LittleEndian(units(0xd83c, 0xdf89))).toBe(true);
  });
});

describe('isUtf16LeText', () => {
  it('is looksUcs16LittleEndian without U+0000', () => {
    expect(isUtf16LeText(units(0x41, 0x42))).toBe(true);
    expect(isUtf16LeText(units(0x41, 0x00, 0x42))).toBe(false);
    expect(isUtf16LeText(units(0x01))).toBe(false);
    expect(isUtf16LeText(Buffer.from(BOM))).toBe(true);
  });
});
