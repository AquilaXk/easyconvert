import { describe, expect, it } from 'vitest';
import { BitmapGlyphs } from '../src/lib/conversions/svg-bitmap-glyph';
import { parseSvgGeometries } from '../src/lib/conversions/svg-geometry';
import { LeftOutPictures } from '../src/lib/conversions/svg-picture';

/**
 * What a caller sets apart from the SVG text when it reads a page: where bitmap glyphs go, what the target does with the pen
 * attributes it cannot paint, and whether pictures are left out and counted. One options object carries all three, and the
 * document the reader returns holds the geometry only, whichever a caller chooses.
 */

const PICTURE = '<image x="0" y="0" width="1" height="1" href="data:image/png;base64,iVBORw0KGgo="/>';
const LINE = '<path d="M 0 0 L 10 10" fill="none" stroke="#000"/>';
const page = (body: string): string => `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">${body}</svg>`;

describe('the options of parseSvgGeometries', () => {
  it('refuses a picture by default and counts the pictures of a page when a collector is given', () => {
    expect(() => parseSvgGeometries(page(`${LINE}${PICTURE}`))).toThrow(/SVG element <image> is not supported/);
    const pictures = new LeftOutPictures();
    const parsed = parseSvgGeometries(page(`${LINE}${PICTURE}<g>${PICTURE}</g>`), { pictures });
    expect(pictures.count).toBe(2);
    expect(parsed.elements).toHaveLength(1);
  });

  it('returns the same document shape with and without a collector', () => {
    const shape = (document: object): string[] => Object.keys(document).sort();
    expect(shape(parseSvgGeometries(page(LINE), { pictures: new LeftOutPictures() }))).toEqual(shape(parseSvgGeometries(page(LINE))));
    expect(shape(parseSvgGeometries(''))).toEqual(shape(parseSvgGeometries(page(LINE))));
  });

  it('refuses an opacity by default and drops it when the pens are centre lines', () => {
    const faded = page('<path d="M 0 0 L 10 10" stroke="#000" opacity="0.5"/>');
    expect(() => parseSvgGeometries(faded)).toThrow(/SVG opacity "0.5" is not supported/);
    expect(parseSvgGeometries(faded, { pens: 'centre-line' }).elements).toHaveLength(1);
  });

  it('refuses a bitmap glyph by default and sets it aside in a collector that takes them', () => {
    const glyph = page(
      `<defs><image id="s" x="0" y="0" width="1" height="1" href="data:image/png;base64,iVBORw0KGgo="/><mask id="m"><use href="#s"/></mask></defs><rect x="0" y="0" width="9" height="9" mask="url(#m)"/>${LINE}`
    );
    expect(() => parseSvgGeometries(glyph)).toThrow(/bitmap glyph/);
    const bitmapGlyphs = new BitmapGlyphs(true);
    expect(parseSvgGeometries(glyph, { bitmapGlyphs }).elements).toHaveLength(1);
    expect(bitmapGlyphs.marks).toHaveLength(1);
  });

  it('takes the three together', () => {
    const pictures = new LeftOutPictures();
    const parsed = parseSvgGeometries(page(`<path d="M 0 0 L 9 9" stroke="#000" opacity="0.2"/>${PICTURE}`), { pens: 'centre-line', pictures, bitmapGlyphs: new BitmapGlyphs(true) });
    expect(parsed.elements).toHaveLength(1);
    expect(pictures.count).toBe(1);
  });
});
