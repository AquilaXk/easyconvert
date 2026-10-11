import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { EngineUnavailableError } from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { withMissingBinary } from './helpers/native-tools';
import { oracleTest } from './helpers/oracle-test';

/**
 * An SVG written as PDF stays a vector page: librsvg draws the paths and the text, instead of a raster picture inside a PDF.
 * Every expectation comes from Poppler and from the SVG itself: the words are read back with pdftotext, the pictures
 * counted with pdfimages, the fonts listed with pdffonts, and the page size read with pdfinfo.
 */

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">
  <rect width="400" height="200" fill="#ffffff"/>
  <circle cx="100" cy="100" r="60" fill="#d62728"/>
  <text x="180" y="110" font-family="DejaVu Sans, sans-serif" font-size="24" fill="#111111">Harbour survey</text>
</svg>`;

function inTempFile<T>(bytes: Buffer, run: (file: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svg-native-'));
  try {
    const file = path.join(dir, 'page.pdf');
    fs.writeFileSync(file, bytes);
    return run(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const poppler = (tool: 'pdftotext' | 'pdfimages' | 'pdffonts' | 'pdfinfo', args: string[], pdf: Buffer): string =>
  inTempFile(pdf, (file) => execFileSync(requireOracleTool(tool), [...args, file, ...(tool === 'pdftotext' ? ['-'] : [])], { encoding: 'utf-8' }));

describe('SVG to PDF', () => {
  oracleTest('keeps the drawing vector: the text is text, no raster picture is in the page, and the page is the drawing size in points', ['rsvg-convert', 'pdftotext', 'pdfimages', 'pdfinfo'], async () => {
    const result = await dispatchConversion(Buffer.from(SVG), 'svg', 'pdf', {}, 'art.svg');
    expect(result.engineUsed).toBe('native-svg');
    expect(poppler('pdftotext', [], result.buffer)).toContain('Harbour survey');
    // pdfimages prints two header lines and one line per picture.
    expect(poppler('pdfimages', ['-list'], result.buffer).trim().split('\n')).toHaveLength(2);
    // 400 x 200 CSS pixels are 300 x 150 points.
    expect(poppler('pdfinfo', [], result.buffer)).toMatch(/Page size:\s+300 x 150 pts/);
  });

  oracleTest('writes the text with embedded fonts, and does not read a local file named by the drawing', ['rsvg-convert', 'pdffonts', 'pdfimages'], async () => {
    const secret = path.join(os.tmpdir(), `svg-native-secret-${process.pid}.png`);
    fs.writeFileSync(secret, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    try {
      const hostile = SVG.replace('</svg>', `<image href="file://${secret}" x="0" y="0" width="50" height="50"/></svg>`);
      const result = await dispatchConversion(Buffer.from(hostile), 'svg', 'pdf', {}, 'art.svg');
      expect(poppler('pdfimages', ['-list'], result.buffer).trim().split('\n')).toHaveLength(2);
      const fonts = poppler('pdffonts', [], result.buffer).trim().split('\n').slice(2);
      expect(fonts.length).toBeGreaterThan(0);
      for (const line of fonts) expect(line).toMatch(/\syes\s+(?:yes|no)\s+(?:yes|no)\s+\d+\s+\d+\s*$/);
    } finally {
      fs.rmSync(secret, { force: true });
    }
  });

  it('falls back to the in-process page, and says so, on a worker without rsvg-convert', async () => {
    const result = await withMissingBinary('RSVG_CONVERT_PATH', () => dispatchConversion(Buffer.from(SVG), 'svg', 'pdf', {}, 'art.svg'));
    expect(result.engineUsed).toBe('internal-fallback');
    expect(result.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(result.fallbackChain?.some((step) => step.startsWith('native-svg:'))).toBe(true);
  });

  it('rejects a drawing the renderer cannot read as a failed conversion, not as a missing engine', async () => {
    const failure = await dispatchConversion(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect'), 'svg', 'pdf', {}, 'broken.svg').then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(EngineUnavailableError);
  });
});
