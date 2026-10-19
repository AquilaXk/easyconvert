import { describe, expect, it } from 'vitest';
import { encodeAscii85, encodePostscript, joinPostscriptPages } from '../src/lib/conversions/image-postscript';
import { decodeAscii85 } from './helpers/postscript-samples';

/**
 * The PostScript writer's ASCII85 and its refusals. The expected text is the encoding that Adobe's specification gives
 * (PostScript Language Reference, 3.13.3: a group of four bytes is five characters, a short last group of n bytes is n + 1
 * characters), written out by hand; the pictures themselves are checked against Ghostscript in image-multipage-postscript.test.ts.
 */

const END_MARKER = '~>';
const MAX_LINE_CHARACTERS = 75;
const LONGEST_RUN = 64;

describe('ASCII85 of the PostScript writer', () => {
  it.each([
    ['Man ', '9jqo^'],
    ['sure.', 'F*2M7/c'],
    ['.', '/c'],
    ['', ''],
  ])('writes %j as %s', (text, encoded) => {
    expect(encodeAscii85(Buffer.from(text, 'latin1')).toString('latin1')).toBe(`${encoded}${END_MARKER}`);
  });

  it('writes a group of zero bytes as five characters, never as z', () => {
    expect(encodeAscii85(Buffer.alloc(4)).toString('latin1')).toBe(`!!!!!${END_MARKER}`);
  });

  it('breaks lines at 75 characters and reads back to the bytes for every length of a short run', () => {
    for (let length = 0; length <= LONGEST_RUN; length += 1) {
      const bytes = Buffer.from(Array.from({ length }, (_unused, index) => (index * 37 + 11) % 256));
      const encoded = encodeAscii85(bytes).toString('latin1');
      expect(encoded.endsWith(END_MARKER)).toBe(true);
      const lines = encoded.split('\n');
      expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(MAX_LINE_CHARACTERS + END_MARKER.length);
      expect(decodeAscii85(encoded.slice(0, -END_MARKER.length)).equals(bytes), `${length} bytes`).toBe(true);
    }
  });
});

describe('PostScript pictures the writer refuses', () => {
  it('refuses samples that are not three bytes to the pixel', async () => {
    await expect(encodePostscript(Buffer.alloc(5), 2, 1, false)).rejects.toMatchObject({
      name: 'ConversionFailedError',
      message: 'The picture holds 5 sample bytes, not the 6 of 2 x 1 pixels',
    });
  });

  it('joins only documents it wrote', () => {
    expect(() => joinPostscriptPages([Buffer.from('%!PS-Adobe-3.0\nshowpage\n')])).toThrow('A page of the PostScript document is not one this converter wrote');
  });
});
