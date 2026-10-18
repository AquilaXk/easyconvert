import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { PdfTextGeometryError, PdfTextUnmappedError } from '../src/lib/conversions/pdf-text-types';
import { captureError } from './helpers/capture-error';
import { extraObjectNumber, rawPdf, type RawPage } from './helpers/raw-pdf';
import { hasControlCharacters } from './helpers/pdf-text-metrics';

/**
 * Text from fonts that have no Unicode mapping: what maps is delivered, what does not is left out and counted in a
 * warning, and a document where nothing maps is still refused. The PDFs are written by hand (tests/helpers/raw-pdf.ts)
 * with a Helvetica whose /Differences name glyphs: the expected text is the string each content stream shows, and no
 * font here carries a /ToUnicode map.
 */

const HTTP_BAD_REQUEST = 400;
/** The font F2 of every page: codes 1 to 3 are ligature glyph names of a typesetting system, 4 and 5 name glyphs no list maps. */
const DIFFERENCES = '/Differences [1 /f_f_i /s_s /t_t 4 /ornamentone /ornamenttwo]';

function pageShowing(shown: string, fontObject: number): RawPage {
  return { width: 400, height: 200, content: `BT /F2 14 Tf 20 100 Td (${shown}) Tj ET`, fonts: `/F2 ${fontObject} 0 R` };
}

/** A document whose pages show `texts` in a font without a /ToUnicode map (octal escapes pick the glyphs by code). */
function documentShowing(...texts: string[]): Buffer {
  const font = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding ${DIFFERENCES} >> >>`;
  const fontObject = extraObjectNumber(texts.length);
  return rawPdf(texts.map((shown) => pageShowing(shown, fontObject)), [font]);
}

async function convert(pdf: Buffer, target: 'txt' | 'md' = 'txt') {
  return convertFile(pdf, 'pdf', target, {}, 'glyphs.pdf');
}

describe('glyph names that the font encoding gives and pdfjs does not map', () => {
  it('reads the ligature names of a typesetting system as the letters they join', async () => {
    const result = await convert(documentShowing('O\\001ce Ma\\002achuse\\003s'));
    expect(result.buffer.toString('utf8').trim()).toBe('Office Massachusetts');
    expect(result.metadata?.warnings).toBeUndefined();
  });

  it('gives the same words in Markdown', async () => {
    const result = await convert(documentShowing('O\\001ce Ma\\002achuse\\003s'), 'md');
    expect(result.buffer.toString('utf8').trim()).toBe('Office Massachusetts');
  });
});

describe('glyphs that no mapping covers', () => {
  it('leaves them out of the text and reports how many', async () => {
    const result = await convert(documentShowing('Total \\004\\005 42 units'));
    const text = result.buffer.toString('utf8');
    expect(hasControlCharacters(text)).toBe(false);
    expect(text.split(/\s+/).filter(Boolean)).toEqual(['Total', '42', 'units']);
    expect(result.metadata?.warnings).toEqual(['Left out 2 glyphs that no font encoding maps to Unicode (page 1).']);
  });

  it('delivers the pages that read and leaves out a page that is mostly glyphs without a mapping, naming it', async () => {
    const result = await convert(documentShowing('Alpha page text', '\\004\\005\\004\\005\\004\\005\\004\\005 Q', 'Gamma page text'));
    const text = result.buffer.toString('utf8');
    expect(hasControlCharacters(text)).toBe(false);
    expect(text).toContain('Alpha page text');
    expect(text).toContain('Gamma page text');
    expect(text).not.toContain('Q');
    expect(result.metadata?.warnings).toEqual(['Left out the text of page 2: more of its glyphs have no Unicode mapping than have one.']);
  });

  it('is still refused with a typed 400 naming the pages when no glyph of the document maps', async () => {
    const error = await captureError(() => convert(documentShowing('\\004\\005\\004\\005', '\\005\\004')));
    expect(error).toBeInstanceOf(PdfTextUnmappedError);
    expect((error as PdfTextUnmappedError).status).toBe(HTTP_BAD_REQUEST);
    expect((error as PdfTextUnmappedError).pages).toEqual([1, 2]);
    expect(error.message).toContain('OCR');
  });
});

describe('glyph names that make one glyph many characters', () => {
  const ITEM_CHARACTERS = 1_048_576;
  /** 64 letters joined by underscores: 127 characters, the longest name a PDF holds, and 64 characters of text. */
  const LONGEST_LIGATURE = Array.from({ length: 64 }, () => 'f').join('_');

  function pageWithLigatureNamed(name: string, glyphs: number): Buffer {
    const font = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [1 /${name}] >> >>`;
    return rawPdf([pageShowing('\\001'.repeat(glyphs), extraObjectNumber(1))], [font]);
  }

  it('is refused with the typed 400 of the page limit when the recovered text outgrows the page', async () => {
    const error = await captureError(() => convert(pageWithLigatureNamed(LONGEST_LIGATURE, ITEM_CHARACTERS)));
    expect(error).toBeInstanceOf(PdfTextGeometryError);
    expect((error as PdfTextGeometryError).status).toBe(HTTP_BAD_REQUEST);
  }, 120_000);
});
