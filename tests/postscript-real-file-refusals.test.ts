import { describe, expect, it } from 'vitest';
import { knownRefusal, readKnownRefusals } from '../bench/realworld/report';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { extractFontsWithExternalPdffonts, extractTextWithExternalPdftotext } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { requireRealworldSample } from './helpers/realworld-sample';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The PostScript files of the real-world corpus (#783) that the nightly run refused, in two groups.
 *
 * Bitmap fonts. Twelve files are dvips or word-processor output whose text is a Type 3 font of 1-bit pictures. Poppler draws a
 * character of such a font as a rectangle painted through a mask that holds the glyph picture, and a DXF holds no bitmaps, so the
 * page cannot be written without losing the text. The refusal names the bitmap glyph (it used to say `SVG mask "url(#mask-0)"`).
 * Both reference writers leave the pictures out (Inkscape's dxf_outlines.py reads only paths, rectangles, lines, circles and
 * ellipses; pstoedit's DXF drivers are declared `noimage`), and pstoedit alone stands a stock font in for the bitmap font as TEXT.
 *
 * Ghostscript. Two files stop the only open-source PostScript interpreter on a value that is legal in an interpreter that is
 * not Ghostscript, in every release from 10.02.1 to the development branch; no argument changes it, and safe mode is not involved.
 */

const BITMAP_GLYPH_REFUSAL = /^ConversionFailedError: The page cannot be written as DXF: SVG bitmap glyph \(a character of a bitmap font, drawn as a picture\) is not supported\.$/;
const MIN_TEXT_CHARACTERS = 100;
const SAMPLE_TIMEOUT_MS = 180_000;

const BITMAP_FONT_FILES = [
  'govdocs1-000097.ps',
  'govdocs1-000730.ps',
  'govdocs1-000773.ps',
  'govdocs1-001048.ps',
  'govdocs1-002433.ps',
  'govdocs1-002956.ps',
  'govdocs1-003229.ps',
  'govdocs1-004087.ps',
  'govdocs1-005434.ps',
  'govdocs1-006007.ps',
  'govdocs1-006137.ps',
  'govdocs1-006955.ps',
] as const;

function describeRefusal(error: unknown): string {
  return `${(error as Error).name}: ${(error as Error).message}`;
}

describe('PostScript files that draw their text with bitmap fonts', () => {
  describe.each(BITMAP_FONT_FILES)('%s', (id) => {
    oracleTest(
      'is refused for DXF with the bitmap glyph named as the reason',
      ['ps2pdf', 'pdftocairo'],
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        const refusal = await dispatchConversion(bytes, 'ps', 'dxf', {}, id).catch((error: unknown) => describeRefusal(error));
        expect(refusal).toMatch(BITMAP_GLYPH_REFUSAL);
      },
      SAMPLE_TIMEOUT_MS
    );

    oracleTest(
      'converts to PDF, whose Type 3 fonts hold the text a DXF would lose',
      ['ps2pdf', 'pdffonts', 'pdftotext'],
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        const pdf = (await dispatchConversion(bytes, 'ps', 'pdf', {}, id)).buffer;
        expect(extractFontsWithExternalPdffonts(pdf).some((font) => font.type === 'Type 3')).toBe(true);
        expect(extractTextWithExternalPdftotext(pdf)?.replace(/\s/g, '').length).toBeGreaterThan(MIN_TEXT_CHARACTERS);
      },
      SAMPLE_TIMEOUT_MS
    );
  });
});

/** The first Ghostscript `Error:` line the real-world files print: what the converter quotes in its refusal. */
const INTERPRETER_REFUSAL = (name: string, operator: string): RegExp =>
  new RegExp(`^ConversionFailedError: The PostScript interpreter rejected the \\.ps file: Error: /${name} in --${operator}--`);

function pageCount(pdf: Buffer): number {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-refusal-pdf-'));
  try {
    const file = path.join(directory, 'out.pdf');
    fs.writeFileSync(file, pdf);
    return Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [file], { encoding: 'utf-8' }))?.[1]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function replaceExactly(source: Buffer, pattern: RegExp, replacement: string, times: number): Buffer {
  const text = source.toString('latin1');
  expect([...text.matchAll(pattern)]).toHaveLength(times);
  return Buffer.from(text.replace(pattern, replacement), 'latin1');
}

describe('PostScript files that Ghostscript stops on', () => {
  describe('govdocs1-002500.ps (WordPerfect 6.1)', () => {
    const id = 'govdocs1-002500.ps';
    /** The font programs fill `Encoding` with integers where `Widths` was meant (Type 3 `Encoding` holds names). */
    const FILLS_ENCODING_WITH_ZEROS = /0 1 255\{Encoding exch 0 put\}for/g;

    oracleTest(
      'is refused by the interpreter at the first glyph added to a font after definefont, in every target',
      ['ps2pdf'],
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        for (const target of ['pdf', 'dxf']) {
          const refusal = await dispatchConversion(bytes, 'ps', target, {}, id).catch((error: unknown) => describeRefusal(error));
          expect(refusal, target).toMatch(INTERPRETER_REFUSAL('invalidaccess', 'put'));
        }
      },
      SAMPLE_TIMEOUT_MS
    );

    oracleTest(
      'converts all 27 pages once the one line that fills Encoding with integers fills Widths: that line is the cause',
      ['ps2pdf', 'pdfinfo'],
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        const repaired = replaceExactly(bytes, FILLS_ENCODING_WITH_ZEROS, '0 1 255{Widths exch 0 put}for', 1);
        expect(pageCount((await dispatchConversion(repaired, 'ps', 'pdf', {}, id)).buffer)).toBe(27);
      },
      SAMPLE_TIMEOUT_MS
    );
  });

  describe('govdocs1-006458.ps (QuickDraw GX printer driver)', () => {
    const id = 'govdocs1-006458.ps';
    /** `MakeCalibratedRGBSpace` declares CIE ranges of 0 to 65535; Ghostscript accepts a CIE parameter of at most 10000. */
    const CIE_RANGES = /\/Range(ABC|LMN) \[0 65535 0 65535 0 65535\]/g;

    oracleTest(
      'is refused by the interpreter at the first CIE colour space, in every target',
      ['ps2pdf'],
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        for (const target of ['pdf', 'dxf']) {
          const refusal = await dispatchConversion(bytes, 'ps', target, {}, id).catch((error: unknown) => describeRefusal(error));
          expect(refusal, target).toMatch(INTERPRETER_REFUSAL('limitcheck', 'setcolorspace'));
        }
      },
      SAMPLE_TIMEOUT_MS
    );

    oracleTest(
      'converts all 24 pages once the two CIE ranges are inside 10000: the range is the cause',
      ['ps2pdf', 'pdfinfo'],
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        const repaired = replaceExactly(bytes, CIE_RANGES, '/Range$1 [0 9999 0 9999 0 9999]', 2);
        expect(pageCount((await dispatchConversion(repaired, 'ps', 'pdf', {}, id)).buffer)).toBe(24);
      },
      SAMPLE_TIMEOUT_MS
    );
  });
});

describe('the nightly gate lists these refusals as explained', () => {
  const explained = readKnownRefusals();
  const refusals: Record<string, string[]> = {
    'govdocs1-002500.ps': ['ConversionFailedError: The PostScript interpreter rejected the .ps file: Error: /invalidaccess in --put--\nOperand stack:'],
    'govdocs1-006458.ps': ['ConversionFailedError: The PostScript interpreter rejected the .ps file: Error: /limitcheck in --setcolorspace--\nOperand stack:'],
    ...Object.fromEntries(BITMAP_FONT_FILES.map((id) => [id, ['ConversionFailedError: The page cannot be written as DXF: SVG bitmap glyph (a character of a bitmap font, drawn as a picture) is not supported.']])),
  };

  it.each(Object.entries(refusals))('%s', (file, details) => {
    for (const detail of details) {
      const job = { file, source: 'ps', target: file === 'govdocs1-002500.ps' || file === 'govdocs1-006458.ps' ? 'pdf' : 'dxf', verdict: 'refused', ms: 0, detail } as const;
      expect(knownRefusal(job, explained), `${file} has a known refusal that matches its error`).not.toBeNull();
    }
  });
});
