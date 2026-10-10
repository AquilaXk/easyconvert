import { describe, it, expect } from 'vitest';
import { readCharacterFontRuns } from '../src/lib/conversions/office/ppt-text-style';

function u16(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value);
  return b;
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0);
  return b;
}

/** A paragraph run with a bullet character and a tab stop list, so the walk over its optional fields is exercised. */
const PARAGRAPH_RUN_MASKS = 0x00000001 | 0x00000080 | 0x00000010 | 0x00100000;
function paragraphRun(count: number): Buffer {
  // count, indent level, masks, bulletFlags, bulletChar, bulletFontRef, tab stop count with two stops.
  return Buffer.concat([u32(count), u16(0), u32(PARAGRAPH_RUN_MASKS), u16(1), u16(0x2022), u16(3), u16(2), u32(0), u32(0)]);
}

describe('PowerPoint character runs', () => {
  it('reads the typeface and symbol typeface of each run after skipping optional paragraph fields', () => {
    const body = Buffer.concat([
      paragraphRun(6),
      // 2 characters: style flags, typeface 4, size 24. Then 4 characters (3 + the closing mark): symbol typeface 7, colour.
      u32(2),
      u32(0x1 | 0x10000 | 0x20000),
      u16(1),
      u16(4),
      u16(24),
      u32(4),
      u32(0x800000 | 0x40000),
      u16(7),
      u32(0x00ffffff),
    ]);
    expect(readCharacterFontRuns(body, 5)).toEqual([
      { start: 0, end: 2, fontRef: 4, symbolFontRef: undefined },
      { start: 2, end: 6, fontRef: undefined, symbolFontRef: 7 },
    ]);
  });

  it('gives up when the atom is cut off, leaves bytes unread, or sets fields it does not know', () => {
    const run = Buffer.concat([u32(3), u32(0x10000), u16(2)]);
    const valid = Buffer.concat([paragraphRun(3), run]);
    expect(readCharacterFontRuns(valid, 2)).toHaveLength(1);
    expect(readCharacterFontRuns(valid.subarray(0, valid.length - 1), 2)).toBeNull();
    expect(readCharacterFontRuns(Buffer.concat([valid, Buffer.from([0])]), 2)).toBeNull();
    expect(readCharacterFontRuns(Buffer.concat([paragraphRun(3), u32(3), u32(0x80000000), u16(2)]), 2)).toBeNull();
    expect(readCharacterFontRuns(valid, 5)).toBeNull();
  });
});
