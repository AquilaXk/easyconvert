import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { convertFile } from '../src/lib/conversions';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { ConversionFailedError, EngineUnavailableError } from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { withMissingBinary } from './helpers/native-tools';
import { withPs2pdfShim, withRejectingPs2pdf } from './helpers/ps2pdf-shim';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * EPS and PS are drawn by a PostScript interpreter: the worker runs ps2pdf and then Poppler, and without
 * the interpreter the answer is a typed 503 error. Nothing in-process guesses at the page.
 */

const SKIP_WITHOUT_PS2PDF = skipWithoutTools('ps2pdf');
const NATIVE_TIMEOUT_MS = 120_000;

/** An EPS written by hand: a filled and a stroked curve, a polygon and one line of text, in a 200 x 120 box. */
const EPS = [
  '%!PS-Adobe-3.0 EPSF-3.0',
  '%%BoundingBox: 0 0 200 120',
  '%%EndComments',
  '0.9 0.2 0.2 setrgbcolor',
  'newpath 20 20 moveto 60 100 140 100 180 20 curveto closepath fill',
  '0 0 0.8 setrgbcolor 3 setlinewidth',
  'newpath 20 60 moveto 100 110 lineto 180 60 lineto stroke',
  '/Helvetica findfont 14 scalefont setfont',
  '10 5 moveto (EPS fixture text) show',
  'showpage',
  '',
].join('\n');

async function onePagePdf(text: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 120]);
  page.drawText(text, { x: 10, y: 60, size: 14, font: await doc.embedFont(StandardFonts.Helvetica) });
  return Buffer.from(await doc.save());
}

describe('PostScript sources without an interpreter', () => {
  it.each([
    ['eps', 'svg'],
    ['eps', 'png'],
    ['eps', 'pdf'],
    ['ps', 'jpg'],
    ['ps', 'tiff'],
  ])('%s -> %s answers a typed 503 error naming ps2pdf', async (source, target) => {
    const run = withMissingBinary('PS2PDF_PATH', () => dispatchConversion(Buffer.from(EPS, 'latin1'), source, target, {}, `figure.${source}`));
    await expect(run).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(run).rejects.toMatchObject({ engineName: 'ps2pdf' });
  });

  it('the in-process engine does not draw a stand-in page', async () => {
    const run = convertFile(Buffer.from(EPS, 'latin1'), 'eps', 'svg', {}, 'figure.eps');
    await expect(run).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(run).rejects.toMatchObject({ engineName: 'ps2pdf' });
  });

  it('advertises every target a native tool chain writes from the interpreter output', () => {
    for (const source of ['eps', 'ps']) {
      const advertised = FORMAT_REGISTRY[source].targetFormats;
      for (const target of ['avif', 'bmp', 'dxf', 'eps', 'gif', 'ps', 'webp']) {
        expect(advertised).toContain(target);
      }
    }
  });
});

describe('PostScript route through the interpreter and Poppler', () => {
  oracleTest('eps -> pdf is the interpreter output, run in safe mode and cropped to the bounding box', ['pdftocairo'], async () => {
    const pdf = await onePagePdf('Interpreter output');
    await withPs2pdfShim(pdf, async (flags) => {
      const result = await dispatchConversion(Buffer.from(EPS, 'latin1'), 'eps', 'pdf', {}, 'figure.eps');
      expect(result.buffer.equals(pdf)).toBe(true);
      expect(result.mimeType).toBe('application/pdf');
      expect(result.filename).toBe('figure.pdf');
      expect(flags()).toEqual(['-dSAFER', '-dEPSCrop']);
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('eps -> svg is what pdftocairo draws from the interpreter output', ['pdftocairo'], async () => {
    const pdf = await onePagePdf('Interpreter output');
    await withPs2pdfShim(pdf, async () => {
      const result = await dispatchConversion(Buffer.from(EPS, 'latin1'), 'eps', 'svg', {}, 'figure.eps');
      const svg = result.buffer.toString('utf-8');
      expect(result.mimeType).toBe('image/svg+xml');
      expect(svg).toContain('<svg');
      expect(svg).not.toContain('width="500" height="500"');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-ref-'));
      try {
        fs.writeFileSync(path.join(dir, 'ref.pdf'), pdf);
        execFileSync(requireOracleTool('pdftocairo'), ['-svg', path.join(dir, 'ref.pdf'), path.join(dir, 'ref.svg')]);
        const reference = fs.readFileSync(path.join(dir, 'ref.svg'), 'utf-8');
        const count = (text: string, tag: string) => [...text.matchAll(new RegExp(`<${tag}\\b`, 'g'))].length;
        expect(count(svg, 'path')).toBe(count(reference, 'path'));
        expect(/viewBox="([^"]+)"/.exec(svg)?.[1]).toBe(/viewBox="([^"]+)"/.exec(reference)?.[1]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('a file the interpreter rejects is a typed 400 error', ['pdftocairo'], async () => {
    await withRejectingPs2pdf('Error: /syntaxerror in --nostringval--', async () => {
      const run = dispatchConversion(Buffer.from('%!PS\n(', 'latin1'), 'ps', 'pdf', {}, 'broken.ps');
      await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
      await expect(run).rejects.toThrow(/syntaxerror/);
    });
  }, NATIVE_TIMEOUT_MS);
});

describe('PostScript against the real interpreter', () => {
  // Ghostscript is licensed under the AGPL and is not part of the CI image until the licence review accepts
  // it, so this check runs wherever it is installed and is skipped, by name, where it is not.
  it.skipIf(SKIP_WITHOUT_PS2PDF)('eps -> svg keeps the curves, fill and text: path count and box match pdftocairo of the ps2pdf output', async () => {
    const result = await dispatchConversion(Buffer.from(EPS, 'latin1'), 'eps', 'svg', {}, 'figure.eps');
    const svg = result.buffer.toString('utf-8');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-real-'));
    try {
      fs.writeFileSync(path.join(dir, 'in.eps'), EPS);
      execFileSync(requireOracleTool('ps2pdf'), ['-dSAFER', '-dEPSCrop', path.join(dir, 'in.eps'), path.join(dir, 'ref.pdf')]);
      execFileSync(requireOracleTool('pdftocairo'), ['-svg', path.join(dir, 'ref.pdf'), path.join(dir, 'ref.svg')]);
      const reference = fs.readFileSync(path.join(dir, 'ref.svg'), 'utf-8');
      const count = (text: string, tag: string) => [...text.matchAll(new RegExp(`<${tag}\\b`, 'g'))].length;
      expect(count(svg, 'path')).toBeGreaterThanOrEqual(2);
      expect(count(svg, 'path')).toBe(count(reference, 'path'));
      expect(/viewBox="([^"]+)"/.exec(svg)?.[1]).toBe(/viewBox="([^"]+)"/.exec(reference)?.[1]);
      // The page is the figure's %%BoundingBox (0 0 200 120), not a default paper size around it.
      expect(/viewBox="([^"]+)"/.exec(svg)?.[1]).toBe('0 0 200 120');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, NATIVE_TIMEOUT_MS);
});
