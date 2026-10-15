import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { applyPdfWatermark } from '../src/lib/conversions/pdf-postprocess';
import { ConversionFailedError, EngineUnavailableError, PdfPostprocessError } from '../src/lib/types';
import { OracleToolMissingError, requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { captureError } from './helpers/capture-error';
import { decodePnm } from './helpers/pnm-decode';

/**
 * Text watermarks in every script. The oracles are Poppler's pdftotext (text in logical order), pdffonts (embedding,
 * subset tag and ToUnicode of every face) and pdftoppm (pixels). Fonts come from the machine; a script no installed
 * font covers skips here and fails under ORACLE_STRICT_MODE=1.
 */

const POPPLER = ['pdftotext', 'pdffonts', 'pdftoppm'] as const;
const PAGE_WIDTH = 500;
const PAGE_HEIGHT = 700;
const WATERMARK_SIZE = 40;
const PDFTOPPM_DPI = 50;
/** The most code points a watermark may have; mirrors the product limit so the test names it. */
const WATERMARK_MAX_CHARS = 256;
const SUPPLEMENTARY_FIRST = 0x10000;
const SUPPLEMENTARY_END = 0x20000;

const NON_LATIN_WATERMARKS = ['대외비', '社外秘', '机密'] as const;
const LATIN_WATERMARK = 'Confidential';

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wm-fonts-'));
}

async function blankPdf(bodyText?: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  if (bodyText) {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText(bodyText, { x: 50, y: 650, size: 16, font, color: rgb(0, 0, 0) });
  }
  return Buffer.from(await doc.save());
}

function writeTemp(pdf: Buffer): { dir: string; file: string } {
  const dir = scratch();
  const file = path.join(dir, 'out.pdf');
  fs.writeFileSync(file, pdf);
  return { dir, file };
}

function pdfText(pdf: Buffer): string {
  const { dir, file } = writeTemp(pdf);
  try {
    return execFileSync(requireOracleTool('pdftotext'), ['-enc', 'UTF-8', file, '-'], { encoding: 'utf-8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

interface FontRow {
  name: string;
  type: string;
  embedded: boolean;
  subset: boolean;
  unicode: boolean;
}

/** Rows of `pdffonts`: the last four columns before the object id are emb, sub, uni. */
function pdfFonts(pdf: Buffer): FontRow[] {
  const { dir, file } = writeTemp(pdf);
  try {
    const listing = execFileSync(requireOracleTool('pdffonts'), [file], { encoding: 'utf-8' });
    return listing
      .split('\n')
      .slice(2)
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const columns = line.trim().split(/\s+/);
        const [emb, sub, uni] = columns.slice(-5, -2);
        return {
          name: columns[0],
          type: columns.slice(1, -5).join(' '),
          embedded: emb === 'yes',
          subset: sub === 'yes',
          unicode: uni === 'yes',
        };
      });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Skips the test (fails it under ORACLE_STRICT_MODE=1) when what it needs is not on this machine. */
function needs(what: string, available: boolean): void {
  if (!available) throw new OracleToolMissingError(what, `${what} is not available on this machine`);
}

/** Whether fontconfig lists an installed face with a glyph for every code point of the text. */
function installedFontCovers(text: string): boolean {
  const fcList = requireOracleTool('fc-list');
  const codePoints = Array.from(new Set(Array.from(text).map((ch) => (ch.codePointAt(0) as number).toString(16))));
  const query = `:charset=${codePoints.join(' ')}`;
  const listing = execFileSync(fcList, [query, 'file'], { encoding: 'utf-8' });
  return /\.(ttf|otf|ttc)/i.test(listing);
}

/** Whether fontconfig lists the family. */
function installedFamily(family: string): boolean {
  return execFileSync(requireOracleTool('fc-list'), [family, 'family'], { encoding: 'utf-8' })
    .split('\n')
    .some((line) => line.split(',').some((name) => name.trim().toLowerCase() === family.toLowerCase()));
}

/** First supplementary-plane letter no installed face covers (from one fontconfig listing), or null. */
function uncoveredCodePoint(): number | null {
  const listing = execFileSync(requireOracleTool('fc-list'), ['--format', '%{charset}\\n'], { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 });
  const covered = new Set<number>();
  for (const token of listing.split(/\s+/).filter(Boolean)) {
    const [first, last] = token.split('-');
    const low = Number.parseInt(first, 16);
    const high = last === undefined ? low : Number.parseInt(last, 16);
    for (let codePoint = low; codePoint <= high; codePoint++) covered.add(codePoint);
  }
  for (let codePoint = SUPPLEMENTARY_FIRST; codePoint < SUPPLEMENTARY_END; codePoint++) {
    if (!covered.has(codePoint) && /\p{L}/u.test(String.fromCodePoint(codePoint))) return codePoint;
  }
  return null;
}

async function stamp(text: string, extra: Record<string, unknown> = {}): Promise<Buffer> {
  return applyPdfWatermark(await blankPdf(), { text, rotation: 0, fontSize: WATERMARK_SIZE, opacity: 1, ...extra });
}

describe('text watermarks in every script', () => {
  for (const watermark of NON_LATIN_WATERMARKS) {
    oracleTest(`${watermark} extracts exactly and its font is an embedded subset with a ToUnicode map`, [...POPPLER, 'fc-list'], async () => {
      needs(`an installed font covering ${watermark}`, installedFontCovers(watermark));
      const out = await stamp(watermark);
      expect(pdfText(out).trim().normalize('NFC')).toBe(watermark.normalize('NFC'));
      const fonts = pdfFonts(out);
      expect(fonts.length).toBeGreaterThan(0);
      for (const font of fonts) {
        expect({ name: font.name, embedded: font.embedded, subset: font.subset, unicode: font.unicode }).toEqual({
          name: font.name,
          embedded: true,
          subset: true,
          unicode: true,
        });
        expect(font.name).toMatch(/^[A-Z]{6}\+/);
      }
    });
  }

  oracleTest('Latin text still extracts exactly', ['pdftotext'], async () => {
    const out = await stamp(LATIN_WATERMARK);
    expect(pdfText(out).trim()).toBe(LATIN_WATERMARK);
  });

  oracleTest('a watermark with a Hangul font family draws with that family', [...POPPLER, 'fc-list'], async () => {
    needs('the Noto Sans CJK KR family', installedFamily('Noto Sans CJK KR'));
    const out = await stamp('대외비 Confidential', { fontFamily: 'Noto Sans CJK KR' });
    expect(pdfFonts(out).some((font) => /NotoSansCJKkr/i.test(font.name))).toBe(true);
    expect(pdfText(out).trim().normalize('NFC')).toBe('대외비 Confidential'.normalize('NFC'));
  });

  it('refuses a font family that is not installed with a client error, not a silent default', async () => {
    const error = await captureError(() => stamp('Confidential', { fontFamily: 'NoSuchFont' }));
    expect(error).toBeInstanceOf(ConversionFailedError);
    expect(error).not.toBeInstanceOf(EngineUnavailableError);
    expect(error).not.toBeInstanceOf(PdfPostprocessError);
    expect(error.name).toBe('WatermarkFontError');
    expect(error.message).toContain('NoSuchFont');
  });

  oracleTest('refuses an installed family that has no glyph for the text', ['fc-list'], async () => {
    needs('the DejaVu Sans family', installedFamily('DejaVu Sans'));
    const error = await captureError(() => stamp('대외비', { fontFamily: 'DejaVu Sans' }));
    expect(error.name).toBe('WatermarkFontError');
    expect(error.message).toContain('DejaVu Sans');
  });

  oracleTest('answers EngineUnavailableError (unicode-font) when no installed font covers the text', ['fc-list'], async () => {
    const codePoint = uncoveredCodePoint();
    needs('a code point no installed font covers', codePoint !== null);
    const error = await captureError(() => stamp(`Sealed ${String.fromCodePoint(codePoint as number)}`));
    expect(error).toBeInstanceOf(EngineUnavailableError);
    expect((error as EngineUnavailableError).engineName).toBe('unicode-font');
  });

  for (const [text, script] of [
    ['سري للغاية', 'Arabic'],
    ['סודי ביותר', 'Hebrew'],
    ['गोपनीय', 'Devanagari'],
  ] as const) {
    oracleTest(`${script} watermark is shaped and extracts in logical order from an embedded subset`, [...POPPLER, 'fc-list'], async () => {
      needs(`an installed font covering ${script}`, installedFontCovers(text));
      const out = await stamp(text);
      expect(pdfText(out).normalize('NFC').replace(/\p{Cf}/gu, '').trim()).toBe(text.normalize('NFC'));
      const fonts = pdfFonts(out);
      expect(fonts.length).toBeGreaterThan(0);
      expect(fonts.every((font) => font.embedded && font.subset && font.unicode)).toBe(true);
    });
  }

  it('refuses a watermark over the length cap and accepts one at the cap', async () => {
    const error = await captureError(() => stamp('A'.repeat(WATERMARK_MAX_CHARS + 1)));
    expect(error).toBeInstanceOf(ConversionFailedError);
    expect(error.name).toBe('WatermarkFontError');
    expect(error.message).toContain(String(WATERMARK_MAX_CHARS));
    await expect(stamp('A'.repeat(WATERMARK_MAX_CHARS))).resolves.toBeInstanceOf(Buffer);
  });

  oracleTest('leaves the page content outside the watermark untouched', ['pdftoppm', 'fc-list'], async () => {
    needs('an installed font covering Hangul', installedFontCovers('대외비'));
    const base = await blankPdf('Body text that must not move');
    const marked = await applyPdfWatermark(base, { text: '대외비', rotation: 0, fontSize: WATERMARK_SIZE, opacity: 1, position: 'bottom-left' });
    const render = (pdf: Buffer) => {
      const { dir, file } = writeTemp(pdf);
      try {
        const root = path.join(dir, 'page');
        execFileSync(requireOracleTool('pdftoppm'), ['-r', String(PDFTOPPM_DPI), '-gray', '-singlefile', file, root]);
        return decodePnm(new Uint8Array(fs.readFileSync(`${root}.pgm`)));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };
    const before = render(base);
    const after = render(marked);
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
    // The watermark sits at the bottom-left; the top half of the page holds the body text and nothing else.
    const topRows = Math.floor(before.height / 2);
    const region = before.width * topRows;
    expect(Buffer.from(after.samples.subarray(0, region)).equals(Buffer.from(before.samples.subarray(0, region)))).toBe(true);
    // And the watermark did draw something in the bottom half.
    expect(Buffer.from(after.samples.subarray(region)).equals(Buffer.from(before.samples.subarray(region)))).toBe(false);
  });
});
