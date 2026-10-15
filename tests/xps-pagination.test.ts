import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildOpenXpsPackage } from '../src/lib/conversions/openxps';
import { convertFile } from '../src/lib/conversions';
import { oracleTest } from './helpers/oracle-test';
import { OracleToolMissingError, requireOracleTool } from './helpers/differential-oracle';
import { deobfuscateFont, readXps } from './helpers/xps-text-walker';

/** Embedding a CJK font writes megabytes and reads them back; a loaded CI runner needs far more than the 5 s default. */
const FONT_EMBEDDING_TIMEOUT_MS = 60_000;
const LINE_COUNT = 200;
const MIN_PAGES = 4;
const SFNT_MAGICS = new Set(['00010000', '4f54544f', '74727565', '74746366']);
/** XPS page width in 1/96 inch for A4: 8.27 inches. */
const A4_WIDTH = 793.76;
const A4_HEIGHT = 1122.56;
const LAYOUT_MARGIN = 48;
const WIDTH_TOLERANCE = 1;
/** A wrapped line stops only when the next word would not fit, so it reaches most of the box. */
const FILL_RATIO = 0.8;

/** The font engine pdfkit itself uses, as an independent shaper for measuring the embedded fonts. */
const fontkit = require('fontkit') as { create(data: Buffer): { unitsPerEm: number; layout(text: string): { advanceWidth: number } } };

const LINES = Array.from({ length: LINE_COUNT }, (_, i) => `Line ${i + 1}: the quick brown fox jumps over the lazy dog`);

function textOf(pages: { glyphs: { text: string }[] }[]): string[] {
  return pages.flatMap((page) => page.glyphs.map((g) => g.text));
}

describe('XPS text pages', () => {
  it('lays 200 lines out over as many fixed pages as they need, each line once and in order', async () => {
    const xps = await readXps(await buildOpenXpsPackage([{ lines: LINES }], 'lines'));
    expect(xps.pages.length).toBeGreaterThanOrEqual(MIN_PAGES);
    expect(textOf(xps.pages)).toEqual(LINES);
    for (const page of xps.pages) {
      expect(page.width).toBeCloseTo(A4_WIDTH, 1);
      expect(page.height).toBeCloseTo(A4_HEIGHT, 1);
      // Every line sits inside the page.
      expect(page.glyphs.filter((g) => g.originY > A4_HEIGHT || g.originY <= 0)).toEqual([]);
    }
  });

  it('draws no title, accent bar or other decoration', async () => {
    const xps = await readXps(await buildOpenXpsPackage([{ title: 'file-name-title', lines: ['only line'] }], 'file-name-title'));
    expect(textOf(xps.pages)).toEqual(['only line']);
    expect(xps.pages.map((page) => page.pathCount)).toEqual([0]);
    const core = await xps.zip.file('docProps/core.xml')!.async('string');
    expect(core).toContain('<dc:title>file-name-title</dc:title>');
  });

  it('wraps a line wider than the page at word boundaries without losing a character', async () => {
    const sentence = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
    const xps = await readXps(await buildOpenXpsPackage([{ lines: [sentence] }], 'wrap'));
    const drawn = textOf(xps.pages);
    expect(drawn.length).toBeGreaterThan(1);
    expect(drawn.join(' ')).toBe(sentence);
  });

  it('breaks a token wider than the page, keeping every character', async () => {
    const token = 'x'.repeat(600);
    const xps = await readXps(await buildOpenXpsPackage([{ lines: [token] }], 'token'));
    expect(textOf(xps.pages).join('')).toBe(token);
  });

  it('embeds the font every Glyphs run names, as an obfuscated font part that decodes to a font file', { timeout: FONT_EMBEDDING_TIMEOUT_MS }, async () => {
    const xps = await readXps(await buildOpenXpsPackage([{ lines: ['Café résumé 한국어 日本語'] }], 'fonts'));
    expect(xps.fontParts.length).toBeGreaterThan(0);
    for (const run of xps.pages.flatMap((page) => page.glyphs)) {
      expect(run.fontUri).toMatch(/\.odttf/);
    }
    for (const part of xps.fontParts) {
      const data = await xps.zip.file(part)!.async('nodebuffer');
      expect(SFNT_MAGICS.has(deobfuscateFont(part, data).subarray(0, 4).toString('hex'))).toBe(true);
    }
    expect(textOf(xps.pages).join('')).toBe('Café résumé 한국어 日本語');
  });

  it('fills each wrapped line up to the right margin, measured with the embedded font by an independent shaper', { timeout: FONT_EMBEDDING_TIMEOUT_MS }, async () => {
    const sentence = Array.from({ length: 80 }, (_, i) => `measure${i}`).join(' ');
    const xps = await readXps(await buildOpenXpsPackage([{ lines: [sentence] }], 'measure'));
    const contentWidth = A4_WIDTH - 2 * LAYOUT_MARGIN;
    const widths: number[] = [];
    for (const page of xps.pages) {
      for (const run of page.glyphs) {
        const part = run.fontUri!.split('#')[0].slice(1);
        const font = fontkit.create(deobfuscateFont(part, await xps.zip.file(part)!.async('nodebuffer')));
        widths.push((font.layout(run.text).advanceWidth * run.fontSize) / font.unitsPerEm);
        expect(run.originX).toBeCloseTo(LAYOUT_MARGIN, 1);
      }
    }
    expect(widths.length).toBeGreaterThan(1);
    // No line is wider than the content box, and every line but the last is nearly full.
    expect(widths.filter((w) => w > contentWidth + WIDTH_TOLERANCE)).toEqual([]);
    expect(widths.slice(0, -1).filter((w) => w < contentWidth * FILL_RATIO)).toEqual([]);
  });
});

/** MuPDF (through PyMuPDF) reads the package: its own XPS parser, sharing nothing with the builder. */
const MUPDF_SCRIPT = `
import json, sys
try:
    import pymupdf as mu
except ImportError:
    import fitz as mu
doc = mu.open(sys.argv[1])
print(json.dumps([[l for l in page.get_text().split('\\n') if l.strip()] for page in doc]))
`;

describe('XPS against an independent reader', () => {
  oracleTest('MuPDF reads all 200 lines from at least four pages', ['python3'], async () => {
    let pages: string[][];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xps-mupdf-'));
    try {
      const result = await convertFile(Buffer.from(LINES.join('\n'), 'utf-8'), 'txt', 'xps', {}, 'lines.txt');
      fs.writeFileSync(path.join(dir, 'lines.xps'), result.buffer);
      let output: string;
      try {
        output = execFileSync(requireOracleTool('python3'), ['-I', '-c', MUPDF_SCRIPT, path.join(dir, 'lines.xps')], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        if (/No module named/.test(String((err as { stderr?: Buffer }).stderr))) throw new OracleToolMissingError('pymupdf');
        throw err;
      }
      pages = JSON.parse(output.trim().split('\n').pop() as string) as string[][];
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(pages.length).toBeGreaterThanOrEqual(MIN_PAGES);
    expect(pages.flat().map((line) => line.trim())).toEqual(LINES);
  }, 240_000);
});
