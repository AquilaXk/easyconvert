import { describe, expect, it } from 'vitest';
import { parseSvgGeometries } from '../src/lib/conversions/svg-geometry';
import { encodeSvgPageToDxf } from '../src/lib/conversions/vector-dxf';
import { encodeEmf } from '../src/lib/conversions/vector-metafile';

/**
 * Poppler draws a page that uses a bitmap font (a dvips document, a Type 3 font of 1-bit pictures) with cairo's SVG surface,
 * which writes each character as a rectangle painted through a mask that holds the glyph picture
 * (`_cairo_svg_document_emit_bitmap_glyph_data` in cairo-svg-surface.c): `<rect mask="url(#mask-N)"/>` in a `<g id="glyph-..">`,
 * with `<mask id="mask-N"><use href="#source-M"/></mask>` and the picture as `<image id="source-M">`. The geometry readers
 * refuse it, because DXF and the metafile encoders hold no bitmaps and dropping the rectangle would drop the character.
 * The refusal has to say what the content is, and every other mask has to stay the plain mask refusal.
 */

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg==';
const BITMAP_GLYPH = /SVG bitmap glyph \(a character of a bitmap font, drawn as a picture\) is not supported/;

function page(defs: string, body: string): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="612pt" height="792pt" viewBox="0 0 612 792">' +
    `<defs>${defs}</defs>${body}</svg>`
  );
}

const pictureMask = (id: string, picture = 'source-0'): string => `<mask id="${id}"><use xlink:href="#${picture}"/></mask>`;
const PICTURE = `<image id="source-0" x="0" y="0" width="1" height="1" xlink:href="${PIXEL}"/>`;
const GLYPH_RECT = (mask: string): string => `<rect x="-5.3" y="-4.9" width="63.6" height="58.8" mask="url(#${mask})" transform="matrix(0.24, 0, 0, 0.24, 0.984, -11.736)"/>`;
const RULE = '<path fill="none" stroke="rgb(0%, 0%, 0%)" d="M 72 100 L 540 100"/>';

/** What Poppler writes for one line of a dvips page: the glyph in a group, drawn with `<use>`, and a rule under the line. */
const BITMAP_LINE = page(
  `${PICTURE}${pictureMask('mask-0')}<g id="glyph-0-0">${GLYPH_RECT('mask-0')}</g>`,
  `${RULE}<g fill="rgb(0%, 0%, 0%)"><use xlink:href="#glyph-0-0" x="72" y="90"/></g>`
);

describe('a bitmap glyph of a page that Poppler drew', () => {
  it('is refused by the DXF writer with the reason, although the page holds a rule it could write', () => {
    expect(() => encodeSvgPageToDxf(Buffer.from(BITMAP_LINE))).toThrow(/^The page cannot be written as DXF: SVG bitmap glyph \(a character of a bitmap font, drawn as a picture\) is not supported\.$/);
  });

  it('is refused by the metafile encoders with the same reason', () => {
    expect(() => encodeEmf(Buffer.from(BITMAP_LINE))).toThrow(BITMAP_GLYPH);
  });

  it('is refused by the geometry reader whichever way the mask is written', () => {
    const inStyle = page(`${PICTURE}${pictureMask('m')}`, `<rect x="0" y="0" width="9" height="9" style="mask: url( #m )"/>`);
    expect(() => parseSvgGeometries(inStyle)).toThrow(BITMAP_GLYPH);
    const pictureDirectly = page(`${PICTURE}<mask id="m"><image x="0" y="0" width="1" height="1" xlink:href="${PIXEL}"/></mask>`, GLYPH_RECT('m'));
    expect(() => parseSvgGeometries(pictureDirectly)).toThrow(BITMAP_GLYPH);
  });
});

describe('a mask that is not a bitmap glyph keeps the plain mask refusal', () => {
  const MASK_REFUSAL = /SVG mask "url\(#m\)" is not supported/;
  const refused = (defs: string, body: string): void => {
    expect(() => parseSvgGeometries(page(defs, body))).toThrow(MASK_REFUSAL);
    expect(() => encodeSvgPageToDxf(Buffer.from(page(defs, body)))).toThrow(MASK_REFUSAL);
  };

  it('a path or a group under a mask', () => {
    refused(`${PICTURE}${pictureMask('m')}`, '<path d="M 0 0 L 9 9" mask="url(#m)"/>');
    refused(`${PICTURE}${pictureMask('m')}`, '<g mask="url(#m)"><path d="M 0 0 L 9 9"/></g>');
  });

  it('a rectangle whose mask draws a shape', () => {
    refused('<mask id="m"><rect x="0" y="0" width="5" height="5" fill="white"/></mask>', GLYPH_RECT('m'));
    refused(`${PICTURE}<mask id="m"><use xlink:href="#source-0"/><path d="M 0 0 L 9 9"/></mask>`, GLYPH_RECT('m'));
  });

  it('a rectangle whose mask is empty, missing or not a mask', () => {
    refused('<mask id="m"></mask>', GLYPH_RECT('m'));
    refused('', GLYPH_RECT('m'));
    refused('<g id="m"><use xlink:href="#m"/></g>', GLYPH_RECT('m'));
  });

  it('a rectangle whose mask points at something that is not a picture', () => {
    refused(`${PICTURE}<mask id="m"><use xlink:href="#missing"/></mask>`, GLYPH_RECT('m'));
    refused(`${PICTURE}<mask id="m"><use xlink:href="https://example.com/a.svg#source-0"/></mask>`, GLYPH_RECT('m'));
  });
});

describe('hostile pages of bitmap glyphs', () => {
  const TIME_LIMIT_MS = 2_000;

  it('a mask that refers to itself is no picture and ends in the mask refusal without looping', () => {
    const started = Date.now();
    const body = GLYPH_RECT('m');
    expect(() => parseSvgGeometries(page('<mask id="m"><use xlink:href="#m"/></mask>', body))).toThrow(/SVG mask "url\(#m\)" is not supported/);
    expect(Date.now() - started).toBeLessThan(TIME_LIMIT_MS);
  });

  it('thirty thousand copies of one glyph are refused at the first, without drawing the rest', () => {
    const uses = '<use xlink:href="#glyph-0-0" x="1" y="1"/>'.repeat(30_000);
    const started = Date.now();
    const svg = page(`${PICTURE}${pictureMask('mask-0')}<g id="glyph-0-0">${GLYPH_RECT('mask-0')}</g>`, uses);
    expect(() => encodeSvgPageToDxf(Buffer.from(svg))).toThrow(BITMAP_GLYPH);
    expect(Date.now() - started).toBeLessThan(TIME_LIMIT_MS);
  });

  it('a mask of thirty thousand pictures is read once, then refused', () => {
    const pictures = '<use xlink:href="#source-0"/>'.repeat(30_000);
    const started = Date.now();
    expect(() => parseSvgGeometries(page(`${PICTURE}<mask id="m">${pictures}</mask>`, GLYPH_RECT('m')))).toThrow(BITMAP_GLYPH);
    expect(Date.now() - started).toBeLessThan(TIME_LIMIT_MS);
  });

  it('a mask whose last picture is followed by a shape is not a picture mask, however long the run before it', () => {
    const pictures = '<use xlink:href="#source-0"/>'.repeat(30_000);
    expect(() => parseSvgGeometries(page(`${PICTURE}<mask id="m">${pictures}<path d="M 0 0 L 1 1"/></mask>`, GLYPH_RECT('m')))).toThrow(
      /SVG mask "url\(#m\)" is not supported/
    );
  });
});
