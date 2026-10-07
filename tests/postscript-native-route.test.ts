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
import { isOracleToolAvailable, requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { withMissingBinary } from './helpers/native-tools';

/**
 * EPS and PS are drawn by a PostScript interpreter: the worker runs ps2pdf and then Poppler, and without
 * the interpreter the answer is a typed 503 error. Nothing in-process guesses at the page.
 */

const HAS_PS2PDF = isOracleToolAvailable('ps2pdf');
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

/** A stand-in interpreter that records its arguments and writes a prepared PDF: it checks the route, not Ghostscript. */
function writeInterpreterShim(dir: string, pdf: Buffer): { shim: string; argsLog: string } {
  const pdfPath = path.join(dir, 'prepared.pdf');
  const argsLog = path.join(dir, 'args.log');
  fs.writeFileSync(pdfPath, pdf);
  const shim = path.join(dir, 'ps2pdf');
  fs.writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$1" > '${argsLog}'\ncp '${pdfPath}' "$3"\n`, { mode: 0o755 });
  return { shim, argsLog };
}

async function withInterpreter<T>(pdf: Buffer, run: (argsLog: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-shim-'));
  const previous = process.env.PS2PDF_PATH;
  try {
    const { shim, argsLog } = writeInterpreterShim(dir, pdf);
    process.env.PS2PDF_PATH = shim;
    return await run(argsLog);
  } finally {
    if (previous === undefined) delete process.env.PS2PDF_PATH;
    else process.env.PS2PDF_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

  it('no longer advertises targets that no engine produces', () => {
    for (const source of ['eps', 'ps']) {
      const advertised = FORMAT_REGISTRY[source].targetFormats;
      for (const target of ['avif', 'bmp', 'dxf', 'eps', 'gif', 'ps', 'webp']) {
        expect(advertised).not.toContain(target);
      }
    }
  });
});

describe('PostScript route through the interpreter and Poppler', () => {
  oracleTest('eps -> pdf is the interpreter output, run in safe mode', ['pdftocairo'], async () => {
    const pdf = await onePagePdf('Interpreter output');
    await withInterpreter(pdf, async (argsLog) => {
      const result = await dispatchConversion(Buffer.from(EPS, 'latin1'), 'eps', 'pdf', {}, 'figure.eps');
      expect(result.buffer.equals(pdf)).toBe(true);
      expect(result.mimeType).toBe('application/pdf');
      expect(result.filename).toBe('figure.pdf');
      expect(fs.readFileSync(argsLog, 'utf-8').trim()).toBe('-dSAFER');
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('eps -> svg is what pdftocairo draws from the interpreter output', ['pdftocairo'], async () => {
    const pdf = await onePagePdf('Interpreter output');
    await withInterpreter(pdf, async () => {
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-fail-'));
    const previous = process.env.PS2PDF_PATH;
    try {
      const shim = path.join(dir, 'ps2pdf');
      fs.writeFileSync(shim, '#!/bin/sh\necho "Error: /syntaxerror in --nostringval--" >&2\nexit 1\n', { mode: 0o755 });
      process.env.PS2PDF_PATH = shim;
      const run = dispatchConversion(Buffer.from('%!PS\n(', 'latin1'), 'ps', 'pdf', {}, 'broken.ps');
      await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
      await expect(run).rejects.toThrow(/syntaxerror/);
    } finally {
      if (previous === undefined) delete process.env.PS2PDF_PATH;
      else process.env.PS2PDF_PATH = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, NATIVE_TIMEOUT_MS);
});

describe('PostScript against the real interpreter', () => {
  // Ghostscript is licensed under the AGPL and is not part of the CI image until the licence review accepts
  // it, so this check runs wherever it is installed and is skipped, by name, where it is not.
  it.skipIf(!HAS_PS2PDF)('eps -> svg keeps the curves, fill and text: path count and box match pdftocairo of the ps2pdf output', async () => {
    const result = await dispatchConversion(Buffer.from(EPS, 'latin1'), 'eps', 'svg', {}, 'figure.eps');
    const svg = result.buffer.toString('utf-8');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-real-'));
    try {
      fs.writeFileSync(path.join(dir, 'in.eps'), EPS);
      execFileSync(requireOracleTool('ps2pdf'), ['-dSAFER', path.join(dir, 'in.eps'), path.join(dir, 'ref.pdf')]);
      execFileSync(requireOracleTool('pdftocairo'), ['-svg', path.join(dir, 'ref.pdf'), path.join(dir, 'ref.svg')]);
      const reference = fs.readFileSync(path.join(dir, 'ref.svg'), 'utf-8');
      const count = (text: string, tag: string) => [...text.matchAll(new RegExp(`<${tag}\\b`, 'g'))].length;
      expect(count(svg, 'path')).toBeGreaterThanOrEqual(2);
      expect(count(svg, 'path')).toBe(count(reference, 'path'));
      expect(/viewBox="([^"]+)"/.exec(svg)?.[1]).toBe(/viewBox="([^"]+)"/.exec(reference)?.[1]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, NATIVE_TIMEOUT_MS);
});
