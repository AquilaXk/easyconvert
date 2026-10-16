import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { ConversionFailedError, UnsupportedOptionError } from '../src/lib/types';
import { ghostscriptPdfArguments, ghostscriptRasterArguments, NO_GARBAGE_COLLECTION_MAX_INPUT_BYTES, siblingGhostscript, skipsGarbageCollection } from '../src/worker/postscript-gs';
import { requireOracleTool } from './helpers/differential-oracle';
import { decodeRgba } from './helpers/imagemagick';
import { oracleTest } from './helpers/oracle-test';

/**
 * PostScript sources run the interpreter itself when it sits next to the configured `ps2pdf`, with the arguments the
 * `ps2pdf` scripts would build, and an EPS that becomes a PNG is drawn once, straight to pixels. The oracles are the
 * interpreter run by hand (`ps2pdf`, and `gs -sDEVICE=png16m` with the same anti-aliasing) and Poppler, both read by
 * tools that share no code with the worker.
 */

const NATIVE_TIMEOUT_MS = 120_000;
const DPI = 100;
const ALPHA_BITS = 4;

/** A 200 x 120 point figure: a red box, a blue circle with a black outline, and a line of text. */
const EPS = [
  '%!PS-Adobe-3.0 EPSF-3.0',
  '%%BoundingBox: 0 0 200 120',
  '%%EndComments',
  '1 1 1 setrgbcolor 0 0 200 120 rectfill',
  '0.84 0.15 0.16 setrgbcolor 10 10 80 40 rectfill',
  '0.12 0.47 0.71 setrgbcolor newpath 130 70 30 0 360 arc fill',
  '0 setgray 2 setlinewidth newpath 130 70 30 0 360 arc stroke',
  '/Helvetica findfont 14 scalefont setfont 10 100 moveto (EPS direct) show',
  'showpage',
  '',
].join('\n');

const TWO_PAGE_EPS = EPS.replace('showpage', 'showpage\n0 0 1 setrgbcolor 0 0 100 60 rectfill\nshowpage');

function withTempDir<T>(prefix: string, run: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A directory that holds a `ps2pdf` that must never run and a `gs` that logs its arguments and runs the real one.
 * `PS2PDF_PATH` points at the first, so the worker finds the second next to it.
 */
async function withSiblingInterpreter<T>(run: (calls: () => string[][], dir: string) => Promise<T>, beforeRun = ''): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-sibling-'));
  const previous = process.env.PS2PDF_PATH;
  try {
    const log = path.join(dir, 'calls.log');
    fs.writeFileSync(path.join(dir, 'ps2pdf'), '#!/bin/sh\necho "ps2pdf must not run" >&2\nexit 99\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'gs'), ['#!/bin/sh', `printf '%s\\n' "$*" >> '${log}'`, beforeRun, `exec '${requireOracleTool('gs')}' "$@"`, ''].join('\n'), { mode: 0o755 });
    process.env.PS2PDF_PATH = path.join(dir, 'ps2pdf');
    return await run(() => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => line.split(' ')) : []), dir);
  } finally {
    if (previous === undefined) delete process.env.PS2PDF_PATH;
    else process.env.PS2PDF_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The figure drawn by the interpreter itself to PNG, at the resolution and anti-aliasing the worker uses. */
function referencePng(eps: string, dpi: number): Buffer {
  return withTempDir('gs-ref-', (dir) => {
    fs.writeFileSync(path.join(dir, 'in.eps'), eps);
    execFileSync(requireOracleTool('gs'), [
      '-q', '-dBATCH', '-dNOPAUSE', '-dSAFER', '-dEPSCrop', '-sDEVICE=png16m',
      `-dGraphicsAlphaBits=${ALPHA_BITS}`, `-dTextAlphaBits=${ALPHA_BITS}`, `-r${dpi}`,
      `-sOutputFile=${path.join(dir, 'ref.png')}`, path.join(dir, 'in.eps'),
    ]);
    return fs.readFileSync(path.join(dir, 'ref.png'));
  });
}

/** Width and height from the header chunk of a PNG. */
function decodeHeader(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function pixelAt(picture: { width: number; data: Buffer }, x: number, y: number): number[] {
  const at = (y * picture.width + x) * 4;
  return [...picture.data.subarray(at, at + 3)];
}

describe('interpreter command lines', () => {
  it('finds gs in the directory of ps2pdf, as the last ps2pdf script does, and nowhere else', () => {
    withTempDir('gs-find-', (dir) => {
      expect(siblingGhostscript(path.join(dir, 'ps2pdf'))).toBeNull();
      fs.writeFileSync(path.join(dir, 'gs'), '#!/bin/sh\n', { mode: 0o644 });
      expect(siblingGhostscript(path.join(dir, 'ps2pdf'))).toBeNull();
      fs.chmodSync(path.join(dir, 'gs'), 0o755);
      expect(siblingGhostscript(path.join(dir, 'ps2pdf'))).toBe(path.join(dir, 'gs'));
    });
  });

  it('writes PDF 1.4 in safe mode, cropped to the bounding box only for an EPS', () => {
    const eps = ghostscriptPdfArguments(true, 'in.eps', 'out.pdf');
    const ps = ghostscriptPdfArguments(false, 'in.ps', 'out.pdf');
    for (const args of [eps, ps]) {
      expect(args).toEqual(expect.arrayContaining(['-dSAFER', '-dCompatibilityLevel=1.4', '-sDEVICE=pdfwrite', '-sOutputFile=out.pdf']));
      expect(args.at(-1)).toMatch(/^in\.e?ps$/);
    }
    expect(eps).toContain('-dEPSCrop');
    expect(ps).not.toContain('-dEPSCrop');
  });

  it('draws PPM pages with the highest anti-aliasing at the requested resolution', () => {
    expect(ghostscriptRasterArguments(true, 150, 'in.eps', 'page-%d.ppm')).toEqual(
      expect.arrayContaining(['-dSAFER', '-dEPSCrop', '-sDEVICE=ppmraw', '-dGraphicsAlphaBits=4', '-dTextAlphaBits=4', '-r150', '-sOutputFile=page-%d.ppm'])
    );
  });
});

describe('PostScript through the interpreter next to ps2pdf', () => {
  oracleTest('eps -> pdf starts gs once and is the PDF ps2pdf writes', ['gs', 'ps2pdf', 'pdftoppm', 'identify'], async () => {
    await withSiblingInterpreter(async (calls) => {
      const result = await dispatchConversion(Buffer.from(EPS, 'latin1'), 'eps', 'pdf', {}, 'figure.eps');
      expect(calls()).toHaveLength(1);
      expect(calls()[0]).toContain('-sDEVICE=pdfwrite');
      expect(result.mimeType).toBe('application/pdf');
      withTempDir('ps2pdf-ref-', (dir) => {
        fs.writeFileSync(path.join(dir, 'in.eps'), EPS);
        fs.writeFileSync(path.join(dir, 'ours.pdf'), result.buffer);
        execFileSync(requireOracleTool('ps2pdf'), ['-dSAFER', '-dEPSCrop', path.join(dir, 'in.eps'), path.join(dir, 'ref.pdf')]);
        const info = (file: string) => execFileSync(requireOracleTool('pdfinfo'), [file], { encoding: 'utf8' }).match(/(Page size|Pages|PDF version):.*/g);
        expect(info(path.join(dir, 'ours.pdf'))).toEqual(info(path.join(dir, 'ref.pdf')));
        const raster = (name: string) => {
          execFileSync(requireOracleTool('pdftoppm'), ['-r', String(DPI), '-png', '-singlefile', path.join(dir, `${name}.pdf`), path.join(dir, name)]);
          return decodeRgba(fs.readFileSync(path.join(dir, `${name}.png`)), 'png');
        };
        expect(raster('ours').data.equals(raster('ref').data)).toBe(true);
      });
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('eps -> png is one interpreter run whose pixels are the interpreter\'s own PNG', ['gs', 'identify'], async () => {
    await withSiblingInterpreter(async (calls) => {
      // Poppler is not needed: a Poppler that would be started is one that cannot run.
      const previousPoppler = process.env.PDFTOPPM_PATH;
      process.env.PDFTOPPM_PATH = '/nonexistent/pdftoppm';
      try {
        const result = await dispatchConversion(Buffer.from(EPS, 'latin1'), 'eps', 'png', { dpi: DPI }, 'figure.eps');
        expect(calls()).toHaveLength(1);
        expect(calls()[0]).toContain('-sDEVICE=ppmraw');
        expect(calls()[0]).not.toContain('-sDEVICE=pdfwrite');
        expect(result.mimeType).toBe('image/png');
        const ours = decodeRgba(result.buffer, 'png');
        const theirs = decodeRgba(referencePng(EPS, DPI), 'png');
        expect(ours.width).toBe(Math.round((200 * DPI) / 72));
        expect(ours.height).toBe(Math.round((120 * DPI) / 72));
        expect(ours.width).toBe(theirs.width);
        expect(ours.height).toBe(theirs.height);
        expect(ours.data.equals(theirs.data)).toBe(true);
        // The drawing itself: red box at the lower left, blue disc in the middle right, white where nothing is drawn.
        const scale = DPI / 72;
        const [red, green, blue] = pixelAt(ours, Math.round(40 * scale), Math.round((120 - 30) * scale));
        expect(red).toBeGreaterThan(180);
        expect(Math.max(green, blue)).toBeLessThan(60);
        const disc = pixelAt(ours, Math.round(130 * scale), Math.round((120 - 70) * scale));
        expect(disc[2]).toBeGreaterThan(150);
        expect(disc[0]).toBeLessThan(60);
        expect(pixelAt(ours, 2, Math.round(60 * scale))).toEqual([255, 255, 255]);
      } finally {
        if (previousPoppler === undefined) delete process.env.PDFTOPPM_PATH;
        else process.env.PDFTOPPM_PATH = previousPoppler;
      }
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('a small figure runs without garbage collection and a large one with it', ['gs', 'identify'], async () => {
    await withSiblingInterpreter(async (calls) => {
      await dispatchConversion(Buffer.from(EPS, 'latin1'), 'eps', 'png', { dpi: DPI }, 'small.eps');
      await dispatchConversion(Buffer.from(EPS, 'latin1'), 'eps', 'pdf', {}, 'small.eps');
      const padding = `% ${'x'.repeat(NO_GARBAGE_COLLECTION_MAX_INPUT_BYTES)}\n`;
      const large = EPS.replace('%%EndComments', `%%EndComments\n${padding}`);
      await dispatchConversion(Buffer.from(large, 'latin1'), 'eps', 'png', { dpi: DPI }, 'large.eps');
      await dispatchConversion(Buffer.from(large, 'latin1'), 'eps', 'pdf', {}, 'large.eps');
      expect(calls().map((call) => call.includes('-dNOGC'))).toEqual([true, true, false, false]);
    });
  }, NATIVE_TIMEOUT_MS);


  oracleTest('a program that runs out of memory without garbage collection is run again with it, and the answer is the same', ['gs', 'identify'], async () => {
    // The stand-in fails the way the interpreter does when its memory runs out, but only while the collector is off.
    const vmError = 'case " $* " in *" -dNOGC "*) echo "Error: /VMerror in --array--" >&2; exit 1 ;; esac';
    await withSiblingInterpreter(async (calls) => {
      for (const target of ['png', 'pdf']) {
        const result = await dispatchConversion(Buffer.from(EPS, 'latin1'), 'eps', target, { dpi: DPI }, 'figure.eps');
        expect(result.buffer.length).toBeGreaterThan(0);
        if (target === 'png') expect(decodeRgba(result.buffer, 'png').data.equals(decodeRgba(referencePng(EPS, DPI), 'png').data)).toBe(true);
      }
      expect(calls().map((call) => call.includes('-dNOGC'))).toEqual([true, false, true, false]);
    }, vmError);
  }, NATIVE_TIMEOUT_MS);

  it('runs without garbage collection only for inputs up to the limit', () => {
    expect(skipsGarbageCollection(NO_GARBAGE_COLLECTION_MAX_INPUT_BYTES)).toBe(true);
    expect(skipsGarbageCollection(NO_GARBAGE_COLLECTION_MAX_INPUT_BYTES + 1)).toBe(false);
    expect(ghostscriptPdfArguments(true, 'in.eps', 'out.pdf', true)).toContain('-dNOGC');
    expect(ghostscriptPdfArguments(true, 'in.eps', 'out.pdf')).not.toContain('-dNOGC');
    expect(ghostscriptRasterArguments(true, 72, 'in.eps', '-', true)).toContain('-dNOGC');
  });

  oracleTest('a figure with several pages takes the PDF route and keeps every page', ['gs', 'pdftoppm', 'identify'], async () => {
    await withSiblingInterpreter(async (calls) => {
      const result = await dispatchConversion(Buffer.from(TWO_PAGE_EPS, 'latin1'), 'eps', 'png', { dpi: DPI }, 'figure.eps');
      const zip = await JSZip.loadAsync(result.buffer);
      expect(Object.keys(zip.files).sort()).toEqual(['figure-p001.png', 'figure-p002.png']);
      expect(calls().map((call) => (call.includes('-sDEVICE=ppmraw') ? 'raster' : 'pdf'))).toEqual(['raster', 'pdf']);
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('a page above the raw-size limit takes the PDF route instead of being held in memory', ['gs', 'pdftoppm', 'identify'], async () => {
    // 4000 x 4000 points at 150 dpi is about 8333 x 8333 pixels: 208 MB of raw RGB, above the 128 MB limit.
    const large = '%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 4000 4000\n%%EndComments\n0.8 0.1 0.1 setrgbcolor 0 0 2000 2000 rectfill\nshowpage\n';
    await withSiblingInterpreter(async (calls) => {
      const result = await dispatchConversion(Buffer.from(large, 'latin1'), 'eps', 'png', { dpi: 150 }, 'large.eps');
      const meta = decodeHeader(result.buffer);
      expect(meta).toEqual({ width: 8334, height: 8334 });
      expect(calls().map((call) => (call.includes('-sDEVICE=ppmraw') ? 'raster' : 'pdf'))).toEqual(['raster', 'pdf']);
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('a page selection takes the PDF route', ['gs', 'pdftoppm', 'identify'], async () => {
    await withSiblingInterpreter(async (calls) => {
      const result = await dispatchConversion(Buffer.from(TWO_PAGE_EPS, 'latin1'), 'eps', 'png', { dpi: DPI, page: 2 }, 'figure.eps');
      expect(decodeRgba(result.buffer, 'png').width).toBe(Math.round((200 * DPI) / 72));
      expect(calls().map((call) => (call.includes('-sDEVICE=ppmraw') ? 'raster' : 'pdf'))).toEqual(['pdf']);
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('a file the interpreter rejects is a typed 400 error naming what it found', ['gs'], async () => {
    await withSiblingInterpreter(async () => {
      for (const target of ['png', 'pdf']) {
        const run = dispatchConversion(Buffer.from('%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\n(', 'latin1'), 'eps', target, { dpi: DPI }, 'broken.eps');
        await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
        await expect(run).rejects.toThrow(/PostScript interpreter rejected the \.eps file/);
      }
    });
  }, NATIVE_TIMEOUT_MS);

  oracleTest('a resolution outside the supported range is refused before the interpreter starts', ['gs'], async () => {
    await withSiblingInterpreter(async (calls) => {
      await expect(dispatchConversion(Buffer.from(EPS, 'latin1'), 'eps', 'png', { dpi: 2000 }, 'figure.eps')).rejects.toBeInstanceOf(UnsupportedOptionError);
      expect(calls()).toHaveLength(0);
    });
  }, NATIVE_TIMEOUT_MS);
});
