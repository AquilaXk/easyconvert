import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { readPdfDocument } from '../src/lib/conversions/pdf-text-document';
import { PdfTextUnmappedError } from '../src/lib/conversions/pdf-text-types';
import { captureError } from './helpers/capture-error';
import { extraObjectNumber, rawPdf, type RawPage } from './helpers/raw-pdf';
import { hasControlCharacters } from './helpers/pdf-text-metrics';

/**
 * A page where the Type 3 glyphs without a Unicode value outnumber the text keeps the text that is not set in a Type 3 font
 * (entry 225). A Type 3 font draws its glyphs with programs of its own, so the lines of a figure are glyphs with no Unicode
 * value and the labels are set in other fonts; what a Type 3 font shows as characters on such a page is its character codes
 * (a bitmap font whose glyphs are named `a16`) and is left out. A page where the glyphs of other fonts outnumber the text, and
 * a page with no such text, are left out as a whole (entry 49). The PDFs are written by hand: Helvetica is the font of the text
 * that maps, F3 is a Type 3 font of two box glyphs, and F2 a Helvetica whose /Differences name two glyphs no list maps.
 */

const FIGURE_GLYPHS = 40;
/** Octal escapes of codes 0 and 1, which the Type 3 font names a0 and a1: control characters, no text. */
const PICTURE_CODES = '\\000\\001'.repeat(FIGURE_GLYPHS / 2);
/** Codes that no glyph name of the Type 3 font maps: pdfjs shows them as the characters Ñ Ö Ù ×, the codes themselves. */
const BITMAP_CODES = '\\321\\326\\331\\327';
const ORNAMENTS = '\\004\\005'.repeat(8);

/** Fonts F3 (Type 3, with its three procedures) and F2 as the objects from `first`. */
function fontObjects(): string[] {
  const procedure = (): string => {
    const program = '10 0 0 0 10 10 d1 0 0 10 10 re f';
    return `<< /Length ${program.length} >>\nstream\n${program}\nendstream`;
  };
  const type3 =
    `<< /Type /Font /Subtype /Type3 /FontBBox [0 0 10 10] /FontMatrix [0.1 0 0 0.1 0 0] /CharProcs << /a0 FIRST1 0 R /a1 FIRST2 0 R >> ` +
    `/Encoding << /Type /Encoding /Differences [0 /a0 /a1] >> /FirstChar 0 /LastChar 1 /Widths [10 10] >>`;
  const helvetica = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [4 /ornamentone /ornamenttwo] >> >>';
  return [type3, procedure(), procedure(), helvetica];
}

function documentOf(contents: string[]): Buffer {
  const first = extraObjectNumber(contents.length);
  const objects = fontObjects().map((body) => body.replace('FIRST1', String(first + 1)).replace('FIRST2', String(first + 2)));
  const fonts = `/F3 ${first} 0 R /F2 ${first + 3} 0 R`;
  const pages: RawPage[] = contents.map((content) => ({ width: 400, height: 200, content, fonts }));
  return rawPdf(pages, objects);
}

const label = (text: string): string => `BT /F1 14 Tf 20 160 Td (${text}) Tj ET\n`;
const type3Run = (codes: string): string => `BT /F3 6 Tf 20 100 Td (${codes}) Tj ET\n`;
const ornamentRun = (text: string): string => `BT /F2 14 Tf 20 60 Td (${text}) Tj ET\n`;

async function toText(pdf: Buffer) {
  const result = await convertFile(pdf, 'pdf', 'txt', {}, 'figure.pdf');
  return { text: result.buffer.toString('utf8'), warnings: result.metadata?.warnings };
}

describe('a page whose Type 3 glyphs without a Unicode value outnumber the text', () => {
  it('keeps the text that no Type 3 font shows, and counts the pictures as glyphs left out', async () => {
    const { text, warnings } = await toText(documentOf([label('Figure 1 Quark model') + type3Run(PICTURE_CODES)]));
    expect(hasControlCharacters(text)).toBe(false);
    expect(text.trim()).toBe('Figure 1 Quark model');
    expect(warnings).toEqual([`Left out ${FIGURE_GLYPHS} glyphs that no font encoding maps to Unicode (page 1).`]);
  });

  it('gives the same words in Markdown', async () => {
    const result = await convertFile(documentOf([label('Figure 1 Quark model') + type3Run(PICTURE_CODES)]), 'pdf', 'md', {}, 'figure.pdf');
    expect(result.buffer.toString('utf8')).toContain('Figure 1 Quark model');
  });

  it('leaves out what a Type 3 font shows as characters, and says so', async () => {
    const { text, warnings } = await toText(documentOf([label('Figure 1 Quark model') + type3Run(PICTURE_CODES + BITMAP_CODES)]));
    expect(text.trim()).toBe('Figure 1 Quark model');
    expect(warnings).toEqual([
      `Left out ${FIGURE_GLYPHS} glyphs that no font encoding maps to Unicode (page 1).`,
      'Left out the Type 3 font text of page 1 and kept the rest: more of its glyphs have no Unicode mapping than have one.',
    ]);
  });

  it('still leaves out a page where the glyphs of other fonts outnumber the text, as entry 49 says', async () => {
    const { text, warnings } = await toText(documentOf([label('First page'), label('Hi') + ornamentRun(`${ORNAMENTS}Q`) + type3Run(PICTURE_CODES), label('Third page')]));
    expect(text).toContain('First page');
    expect(text).toContain('Third page');
    expect(text).not.toContain('Hi');
    expect(warnings).toEqual(['Left out the text of page 2: more of its glyphs have no Unicode mapping than have one.']);
  });

  it('still leaves out a page with no text but the Type 3 characters, naming it', async () => {
    const { text, warnings } = await toText(documentOf([label('First page'), type3Run(PICTURE_CODES + BITMAP_CODES), label('Third page')]));
    expect(text).toContain('First page');
    expect(text).toContain('Third page');
    expect(text).not.toMatch(/[ÑÖÙ×]/u);
    expect(warnings).toEqual(['Left out the text of page 2: more of its glyphs have no Unicode mapping than have one.']);
  });

  it('is still refused when no page of the document keeps text', async () => {
    const error = await captureError(() => toText(documentOf([type3Run(PICTURE_CODES + BITMAP_CODES)])));
    expect(error).toBeInstanceOf(PdfTextUnmappedError);
  });

  it('leaves the page to OCR as a whole when OCR is on', async () => {
    const read = await readPdfDocument(documentOf([label('Figure 1 Quark model') + type3Run(PICTURE_CODES)]), { onUnmapped: 'omit' });
    expect(read.extracted.unmappedPages).toEqual([1]);
    expect(read.extracted.pages[0].items).toEqual([]);
  });
});
