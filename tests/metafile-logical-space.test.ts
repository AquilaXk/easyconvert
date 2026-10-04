import { describe, it, expect } from 'vitest';
import { encodeEmf, encodeWmf } from '../src/lib/conversions/vector-metafile';
import { CadGeometryUnavailableError } from '../src/lib/types';

function lineDrawing(extent: number): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${extent}" height="${extent}"><line x1="0" y1="0" x2="${extent}" y2="${extent}" stroke="#000" stroke-width="2"/></svg>`,
    'utf-8'
  );
}

describe('metafile logical space resolution floor', () => {
  it.each([
    ['EMF', encodeEmf],
    ['WMF', encodeWmf],
  ])('%s rejects a 3e6 px drawing that would collapse to about one unit per inch', (_name, encode) => {
    expect(() => encode(lineDrawing(3_000_000))).toThrow(CadGeometryUnavailableError);
    expect(() => encode(lineDrawing(3_000_000))).toThrow(/resolution|too large/);
  });

  it('still encodes a drawing scaled to a coarse but usable resolution', () => {
    // 100000 px scales to 31 units per inch, above the 8 unit floor
    expect(encodeEmf(lineDrawing(100_000)).subarray(40, 44).toString('latin1')).toBe(' EMF');
  });
});
