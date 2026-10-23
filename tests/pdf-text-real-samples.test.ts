import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { convertFile } from '../src/lib/conversions/index';
import { PdfStructureError } from '../src/lib/conversions/pdf-document';
import { ConversionFailedError } from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { captureError } from './helpers/capture-error';
import { characterF1, hasControlCharacters, wordF1 } from './helpers/pdf-text-metrics';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * The PDF text rows of #783 on the real files of the corpus (bench/realworld/manifest.json, and for the two cc- files
 * bench/realworld/regression-manifest.json, which holds them): fonts without a Unicode map,
 * PDFs that open with the empty password, and PDFs that no reader can open. Poppler (`pdftotext`, `pdfimages`) is the
 * independent reader: it reads the same bytes, and the expected strings are ones its output holds (one test, where Poppler
 * leaves the glyphs out, says what it compares with instead).
 */

const toolsMissing = skipWithoutTools('pdftotext', 'pdfimages');
const CONVERSION_TIMEOUT_MS = 120_000;
/** Words of the converted text that the reference reader's text may lack, and the reverse (headers, ligature spelling, glyphs left out). */
const MIN_WORD_F1 = 0.97;
/** Japanese text: the characters of the two readers, compared as multisets because the language puts no spaces between words. */
const MIN_CHARACTER_F1 = 0.95;
/** A 117-page book with math and figures: the reading orders of the two readers differ more than for plain prose. */
const MIN_BOOK_WORD_F1 = 0.93;
const HTTP_BAD_REQUEST = 400;
const MAX_POPPLER_OUTPUT_BYTES = 64 * 1024 * 1024;

function withPdfFile<T>(bytes: Buffer, use: (file: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-real-sample-'));
  try {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, bytes);
    return use(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** What `pdftotext` prints for the bytes; it opens a file with an empty password. */
function pdftotext(bytes: Buffer, ...args: string[]): string {
  return withPdfFile(bytes, (file) =>
    execFileSync(requireOracleTool('pdftotext'), ['-q', '-enc', 'UTF-8', ...args, file, '-'], { encoding: 'utf8', maxBuffer: MAX_POPPLER_OUTPUT_BYTES })
  );
}

/** Number of image rows `pdfimages -list` shows. */
function pdfImageCount(bytes: Buffer): number {
  return withPdfFile(bytes, (file) => {
    const rows = execFileSync(requireOracleTool('pdfimages'), ['-list', file], { encoding: 'utf8' }).trim().split('\n');
    return rows.length - 2;
  });
}

/** Characters that stand for a glyph without a Unicode value: pdftotext writes the character code, or a private-use character. */
// eslint-disable-next-line no-control-regex
const NO_TEXT_GLYPH = /[\u0000-\u0008\u000b\u000e-\u001f\u007f\uE000-\uF8FF]/gu;

/** Per page (pdftotext ends every page with a form feed) the number of glyphs pdftotext printed without a Unicode value. */
function glyphsWithoutText(reference: string): Map<number, number> {
  const pages = new Map<number, number>();
  reference.split('\f').forEach((page, index) => {
    const count = page.match(NO_TEXT_GLYPH)?.length ?? 0;
    if (count > 0) pages.set(index + 1, count);
  });
  return pages;
}

/** The warning of the converter for those glyphs: the total, and the first ten pages. */
function expectedLeftOut(glyphs: Map<number, number>): string {
  const pages = [...glyphs.keys()];
  const total = [...glyphs.values()].reduce((sum, count) => sum + count, 0);
  const named = `${pages.slice(0, 10).join(', ')}${pages.length > 10 ? ', ...' : ''}`;
  return `Left out ${total} glyphs that no font encoding maps to Unicode (${pages.length === 1 ? 'page' : 'pages'} ${named}).`;
}

const withoutControls = (text: string): string => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uE000-\uF8FF]/g, '');

async function textOf(bytes: Buffer, target: 'txt' | 'md' = 'txt') {
  return convertFile(bytes, 'pdf', target, {}, 'sample.pdf');
}

describe.skipIf(toolsMissing)('fonts without a Unicode map (real files)', () => {
  it('govdocs1-000163.pdf: reads Massachusetts from the ligature glyphs s_s and e_t_t of a Type 1 font', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'govdocs1-000163.pdf');
    const text = (await textOf(bytes)).buffer.toString('utf8');
    expect(text.match(/Boston, Massachusetts/g)).toHaveLength(pdftotext(bytes).match(/Boston, Massachusetts/g)?.length ?? -1);
    expect(text).toContain('Boston, Massachusetts');
    expect(hasControlCharacters(text)).toBe(false);
  }, CONVERSION_TIMEOUT_MS);

  it('pdf-pdfjs-issue918.pdf: leaves out the glyphs of a bitmap font that have no name, as many as the reference reader prints as control codes', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'pdf-pdfjs-issue918.pdf');
    const result = await textOf(bytes, 'md');
    const text = result.buffer.toString('utf8');
    const reference = pdftotext(bytes);
    const glyphs = glyphsWithoutText(reference);
    expect([...glyphs.keys()]).toEqual([1]);
    expect(hasControlCharacters(text)).toBe(false);
    expect(wordF1(withoutControls(reference), text)).toBeGreaterThanOrEqual(MIN_WORD_F1);
    expect(result.metadata?.warnings).toEqual([expectedLeftOut(glyphs)]);
  }, CONVERSION_TIMEOUT_MS);

  it('pdf-pypdf-geotopo.pdf: delivers the 117 pages of a TeX book although a few of its math symbols have no Unicode value', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'pdf-pypdf-geotopo.pdf');
    const result = await textOf(bytes);
    const text = result.buffer.toString('utf8');
    const reference = pdftotext(bytes);
    expect(hasControlCharacters(text)).toBe(false);
    expect(wordF1(withoutControls(reference), text)).toBeGreaterThanOrEqual(MIN_BOOK_WORD_F1);
    // pdfjs reads some glyphs that pdftotext cannot (cmex pieces, Symbol ligatures): what it leaves out is part of what pdftotext prints as no text.
    const [warning] = (result.metadata?.warnings as string[] | undefined) ?? [];
    const left = /^Left out (\d+) glyphs that no font encoding maps to Unicode \(pages ([\d, .]+)\)\.$/.exec(warning ?? '');
    expect(left, warning).not.toBeNull();
    const [, count, named] = left as RegExpExecArray;
    expect(Number(count)).toBeGreaterThan(0);
    const referencePages = glyphsWithoutText(reference);
    expect(Number(count)).toBeLessThanOrEqual([...referencePages.values()].reduce((sum, glyphs) => sum + glyphs, 0));
    const shown = named.split(', ').filter((page) => page !== '...').map(Number);
    expect(shown.length).toBe(10);
    for (const page of shown) expect(referencePages.has(page), `pdftotext prints glyphs without text on page ${page}`).toBe(true);
  }, CONVERSION_TIMEOUT_MS);

  it('cc-6200417.pdf: reads the composite TrueType fonts of a CAD plot, which have no ToUnicode map, through their programs', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'cc-6200417.pdf');
    const result = await textOf(bytes);
    const text = result.buffer.toString('utf8');
    // Poppler leaves out every glyph of the plot's unknown character collection, so the strings are the ones the page shows
    // when it is drawn (pdftoppm): titles, a floor area and room names set in those fonts.
    for (const shown of ['SCHEMAT ZAGOSPODAROWANIA DZIAŁKI', 'pow. użytkowa 54,86', 'Przedpokój', 'Aranżacja lokalu przedstawiona na rzucie jest przykładowa.']) {
      expect(text).toContain(shown);
    }
    expect(hasControlCharacters(text)).toBe(false);
    expect(result.metadata?.warnings).toBeUndefined();
  }, CONVERSION_TIMEOUT_MS);

  it('cc-6800345.pdf: reads Japanese text set in fonts with a predefined CJK CMap and no embedded program', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'cc-6800345.pdf');
    const text = (await textOf(bytes)).buffer.toString('utf8');
    const reference = pdftotext(bytes);
    expect(text).toContain('窪田製薬ホールディングス株式会社');
    expect(characterF1(reference, text)).toBeGreaterThanOrEqual(MIN_CHARACTER_F1);
  }, CONVERSION_TIMEOUT_MS);
});

describe.skipIf(toolsMissing)('PDFs that open with the empty password (real files)', () => {
  it('qpdf-enc-r3-v2.pdf: converts to hOCR and ALTO with the words the reference reader finds', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'qpdf-enc-r3-v2.pdf');
    const words = pdftotext(bytes).split(/\s+/).filter((word) => /^\p{L}{5,}$/u.test(word)).slice(0, 8);
    expect(words.length).toBeGreaterThanOrEqual(8);
    for (const target of ['hocr', 'alto'] as const) {
      const output = (await convertFile(bytes, 'pdf', target, {}, 'sample.pdf')).buffer.toString('utf8');
      for (const word of words) expect(output, `${target} holds "${word}"`).toContain(word);
    }
  }, CONVERSION_TIMEOUT_MS);

  it('pdfjs-pr6531_2.pdf: opens with the empty password, which is its owner password, as the reference reader opens it', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'pdfjs-pr6531_2.pdf');
    const text = (await textOf(bytes, 'md')).buffer.toString('utf8');
    expect(wordF1(pdftotext(bytes), text)).toBeGreaterThanOrEqual(MIN_WORD_F1);
  }, CONVERSION_TIMEOUT_MS);

  it('qpdf-encrypted-with-images.pdf: writes the pictures of a PDF with no text into Markdown, with the sizes the reference reader lists', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'qpdf-encrypted-with-images.pdf');
    const markdown = (await textOf(bytes, 'md')).buffer.toString('utf8');
    const pictures = [...markdown.matchAll(/!\[[^\]]*\]\(data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/=]+)\)/g)];
    expect(pictures).toHaveLength(pdfImageCount(bytes));
    const sizes = await Promise.all(pictures.map(async ([, data]) => {
      const { width, height } = await sharp(Buffer.from(data, 'base64')).metadata();
      return `${width}x${height}`;
    }));
    expect(sizes).toEqual(['555x600', '185x200', '185x200']);
  }, CONVERSION_TIMEOUT_MS);
});

describe.skipIf(toolsMissing)('pages with nothing to read (real files)', () => {
  for (const id of ['pdfjs-empty_protected.pdf', 'pdf-vera-pdfa1b-devicen.pdf', 'pdf-pdfjs-issue17333.pdf']) {
    it(`${id}: has no text and no picture for the reference readers, so an empty Markdown file is right`, async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, id);
      expect(pdftotext(bytes).trim()).toBe('');
      expect(pdfImageCount(bytes)).toBe(0);
      expect((await textOf(bytes, 'md')).buffer.toString('utf8').trim()).toBe('');
    }, CONVERSION_TIMEOUT_MS);
  }
});

describe.skipIf(toolsMissing)('PDFs whose page tree no reader finds (real files)', () => {
  for (const id of ['pdfjs-bug1020226.pdf', 'qpdf-issue-101.pdf']) {
    it(`${id}: is a typed refusal to text, not the failure of the reference reader's process`, async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, id);
      const error = await captureError(() => dispatchConversion(bytes, 'pdf', 'txt', {}, id));
      expect(error).toBeInstanceOf(ConversionFailedError);
      expect(error.name).not.toBe('SandboxedProcessError');
      expect(error.message).not.toContain('Syntax Error');
      expect((error as { status?: number }).status ?? HTTP_BAD_REQUEST).toBe(HTTP_BAD_REQUEST);
    }, CONVERSION_TIMEOUT_MS);
  }

  it('qpdf-issue-101.pdf: is a typed 400 naming the damage when the worker may not fall back to the in-process reader', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'qpdf-issue-101.pdf');
    const error = await captureError(() => dispatchConversion(bytes, 'pdf', 'txt', { inProcessFallback: false }, 'qpdf-issue-101.pdf'));
    expect(error).toBeInstanceOf(PdfStructureError);
    expect(error.message).toBe('The PDF is damaged: Poppler cannot find its page tree, so its text cannot be read.');
  }, CONVERSION_TIMEOUT_MS);

  it('pdfjs-issue9105_other.pdf: is read to text by the in-process reader, which finds the page that Poppler does not', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'pdfjs-issue9105_other.pdf');
    const result = await dispatchConversion(bytes, 'pdf', 'txt', {}, 'pdfjs-issue9105_other.pdf');
    expect(result.buffer.toString('utf8').trim()).toBe('Adobe tweet');
    expect(String(bytes)).toContain('(Adobe tweet) Tj');
  }, CONVERSION_TIMEOUT_MS);
});
