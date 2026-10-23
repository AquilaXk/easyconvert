import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { extractPdfDocument } from '../src/lib/conversions/pdf-text-document';
import { PdfTextUnmappedError } from '../src/lib/conversions/pdf-text-types';
import { captureError } from './helpers/capture-error';
import { requireOracleTool } from './helpers/differential-oracle';
import { extraObjectNumber, rawPdf } from './helpers/raw-pdf';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * Character code 0 of a simple font that is not symbolic and whose encoding names no glyph there. No standard encoding
 * names a glyph at code 0, so the code selects glyph 0, the .notdef glyph (pdf.js `src/core/fonts.js`, PR 21487 for
 * issue 17333: a symbol font may draw a checkbox there). The .notdef glyph has no character: Poppler's `pdftotext` prints
 * nothing for it, pdf.js gives the code itself (U+0000) and MuPDF U+FFFD. It is no text the reader failed to map, so it
 * is neither counted nor reported, and a page that draws only such glyphs has no text, as for the references.
 *
 * The PDFs are written by hand: a non-embedded Helvetica with the WinAnsi encoding, and the DejaVu Sans subset that fontTools
 * wrote (tests/fixtures/woff2) as a TrueType font, flagged nonsymbolic with the WinAnsi encoding or symbolic with none. pdf.js
 * itself already draws an unnamed code of a Type 1 font it does not have as a space (`Font._charToGlyph`, the `missingFile`
 * branch), so the Helvetica cases hold before and after; the embedded font is the case the rule is for.
 */

const toolsMissing = skipWithoutTools('pdftotext');
const TIMEOUT_MS = 120_000;
const FONT_PROGRAM = fs.readFileSync(path.join(__dirname, 'fixtures', 'woff2', 'dejavu-sans-latin.ttf'));
const NONSYMBOLIC = 32;
const SYMBOLIC = 4;

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function pdftotext(bytes: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-notdef-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'in.pdf');
  fs.writeFileSync(file, bytes);
  return execFileSync(requireOracleTool('pdftotext'), ['-q', '-enc', 'UTF-8', file, '-'], { encoding: 'utf8' });
}

const wordsOf = (text: string): string[] => text.split(/\s+/).filter(Boolean);

const helvetica = (encoding: string) => `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding ${encoding} >>`;
const WIN_ANSI = '/WinAnsiEncoding';

/** DejaVu Sans as a simple TrueType font with the given descriptor flags and /Encoding entry (none when empty). */
function dejaVuObjects(first: number, flags: number, encoding: string): string[] {
  return [
    `<< /Type /Font /Subtype /TrueType /BaseFont /DejaVuSans ${encoding} /FirstChar 0 /LastChar 0 /Widths [600] /FontDescriptor ${first + 1} 0 R >>`,
    `<< /Type /FontDescriptor /FontName /DejaVuSans /Flags ${flags} /FontBBox [-1021 -463 1793 1232] /ItalicAngle 0 /Ascent 928 /Descent -236 /CapHeight 729 /StemV 80 /FontFile2 ${first + 2} 0 R >>`,
    `<< /Length ${FONT_PROGRAM.length} /Length1 ${FONT_PROGRAM.length} >>\nstream\n${FONT_PROGRAM.toString('latin1')}\nendstream`,
  ];
}

/** One page that shows `shown` (a literal string; `\\000` is code 0) in font F2, written by `font`. */
function pageShowing(shown: string, font: (first: number) => string[]): Buffer {
  const first = extraObjectNumber(1);
  return rawPdf([{ width: 400, height: 200, content: `BT /F2 14 Tf 20 100 Td (${shown}) Tj ET`, fonts: `/F2 ${first} 0 R` }], font(first));
}

const NOTDEF_FONTS = [
  ['a Helvetica with the WinAnsi encoding', () => [helvetica(WIN_ANSI)]],
  ['a Helvetica whose /Differences name no glyph at 0', () => [helvetica(`<< /Type /Encoding /BaseEncoding ${WIN_ANSI} /Differences [1 /A] >>`)]],
  ['an embedded nonsymbolic TrueType font with the WinAnsi encoding', (first: number) => dejaVuObjects(first, NONSYMBOLIC, `/Encoding ${WIN_ANSI}`)],
] as const;

describe.skipIf(toolsMissing)('code 0 of a nonsymbolic simple font with no glyph name there', () => {
  it.each(NOTDEF_FONTS)('is no text on a page that draws only that glyph, in %s', async (_case, font) => {
    const pdf = pageShowing('\\000', font);
    expect(wordsOf(pdftotext(pdf))).toEqual([]);
    const read = await extractPdfDocument(pdf);
    expect(read.text.trim()).toBe('');
    expect(read.unmappedPages).toEqual([]);
  });

  it.each(NOTDEF_FONTS)('is left out of the text beside letters without a warning, in %s', async (_case, font) => {
    const pdf = pageShowing('Total \\000 42 units', font);
    const result = await convertFile(pdf, 'pdf', 'txt', {}, 'notdef.pdf');
    const text = result.buffer.toString('utf8');
    expect(wordsOf(text)).toEqual(['Total', '42', 'units']);
    // The test fonts give the letters no width, so Poppler joins some words; its letters are the same.
    expect(text.replace(/\s/g, '')).toBe(pdftotext(pdf).replace(/\s/g, ''));
    expect(result.metadata?.warnings).toBeUndefined();
  }, TIMEOUT_MS);
});

describe('code 0 that is not the .notdef glyph by the encoding is still a glyph without a mapping', () => {
  it('is counted when the /Differences name a glyph at 0 that no list maps, and a page of it alone is refused', async () => {
    const pdf = pageShowing('\\000\\000', () => [helvetica(`<< /Type /Encoding /BaseEncoding ${WIN_ANSI} /Differences [0 /ornamentone] >>`)]);
    const error = await captureError(() => extractPdfDocument(pdf));
    expect(error).toBeInstanceOf(PdfTextUnmappedError);
    expect((error as PdfTextUnmappedError).pages).toEqual([1]);
  });

  it('is counted in a symbolic font, whose built-in encoding may draw any glyph at 0, and a page of it alone is refused', async () => {
    const pdf = pageShowing('\\000\\000', (first) => dejaVuObjects(first, SYMBOLIC, ''));
    const error = await captureError(() => extractPdfDocument(pdf));
    expect(error).toBeInstanceOf(PdfTextUnmappedError);
  });

  it('leaves codes 1 to 31 counted: a standard encoding names none of them either, but a font may draw a glyph there', async () => {
    const pdf = pageShowing('\\001\\002\\003', (first) => dejaVuObjects(first, NONSYMBOLIC, `/Encoding ${WIN_ANSI}`));
    const error = await captureError(() => extractPdfDocument(pdf));
    expect(error).toBeInstanceOf(PdfTextUnmappedError);
  });
});

describe.skipIf(toolsMissing)('real file: pdf-pdfjs-issue17333.pdf', () => {
  it('converts to the empty text the references print for its one checkbox glyph at code 0', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'pdf-pdfjs-issue17333.pdf');
    expect(wordsOf(pdftotext(bytes))).toEqual([]);
    const read = await extractPdfDocument(bytes);
    expect(read.text.trim()).toBe('');
    expect(read.unmappedPages).toEqual([]);
  }, TIMEOUT_MS);
});
