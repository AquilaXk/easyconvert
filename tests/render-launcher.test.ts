import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { sandboxLauncherState, startSandboxLauncher, stopSandboxLauncher } from '../src/lib/security/sandbox-launcher';
import { ConversionFailedError } from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { decodeRgba } from './helpers/imagemagick';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';

/**
 * SVG and PostScript renders when the program is started through the launcher helper (src/lib/security/sandbox-launcher.ts),
 * which is what a worker of a few hundred megabytes does. The process reports a large resident size, as such a worker has,
 * so that the helper is judged worth it. Each test checks that the helper started the program (the count of launched
 * programs rises), and the results are read back by tools that share no code with the product: Poppler for the PDF text
 * and page size, and the interpreter's own PNG device for the pixels.
 */

const LARGE_WORKER_BYTES = 1024 * 1024 * 1024;
const DPI = 100;
const ALPHA_BITS = 4;
const NATIVE_TIMEOUT_MS = 120_000;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">
  <rect width="400" height="200" fill="#ffffff"/>
  <circle cx="100" cy="100" r="60" fill="#d62728"/>
  <text x="180" y="110" font-family="DejaVu Sans, sans-serif" font-size="24" fill="#111111">Harbour survey</text>
</svg>`;

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

const toolsMissing = skipWithoutTools('rsvg-convert', 'gs', 'ps2pdf', 'pdfinfo', 'pdftotext', 'identify');

function inTempDir<T>(run: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-launcher-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const poppler = (tool: 'pdfinfo' | 'pdftotext', pdf: Buffer): string =>
  inTempDir((dir) => {
    const file = path.join(dir, 'page.pdf');
    fs.writeFileSync(file, pdf);
    return execFileSync(requireOracleTool(tool), tool === 'pdftotext' ? [file, '-'] : [file], { encoding: 'utf-8' });
  });

/** The figure drawn by the interpreter's own PNG device, at the resolution and anti-aliasing the worker uses. */
function referencePng(eps: string, dpi: number): Buffer {
  return inTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'in.eps'), eps);
    execFileSync(requireOracleTool('gs'), [
      '-q', '-dBATCH', '-dNOPAUSE', '-dSAFER', '-dEPSCrop', '-sDEVICE=png16m',
      `-dGraphicsAlphaBits=${ALPHA_BITS}`, `-dTextAlphaBits=${ALPHA_BITS}`, `-r${dpi}`,
      `-sOutputFile=${path.join(dir, 'ref.png')}`, path.join(dir, 'in.eps'),
    ]);
    return fs.readFileSync(path.join(dir, 'ref.png'));
  });
}

/** Whether this host lets an unprivileged process create a user and network namespace, which strict isolation needs. */
const canIsolateNetwork = process.platform === 'linux' && spawnSync('unshare', ['-r', '-n', '--', 'true'], { stdio: 'ignore' }).status === 0;
const noNamespaces = skipUnless('unprivileged user and network namespaces (unshare -r -n)', canIsolateNetwork);

/** Runs `operation` and returns what it returned with the number of programs the helper started during it. */
async function launched<T>(operation: () => Promise<T>): Promise<{ value: T; programs: number }> {
  const before = sandboxLauncherState().launched;
  const value = await operation();
  return { value, programs: sandboxLauncherState().launched - before };
}

describe.skipIf(toolsMissing || noNamespaces)('SVG and PostScript renders through the launcher', () => {
  beforeAll(async () => {
    vi.spyOn(process.memoryUsage, 'rss').mockReturnValue(LARGE_WORKER_BYTES);
    expect(await startSandboxLauncher()).toBe(true);
  }, 60_000);

  afterAll(() => {
    vi.restoreAllMocks();
    stopSandboxLauncher();
  });

  it('svg -> pdf: the helper starts the renderer once, and the page is the drawing with its text', async () => {
    const { value, programs } = await launched(() => dispatchConversion(Buffer.from(SVG), 'svg', 'pdf', {}, 'art.svg'));
    expect(programs).toBe(1);
    expect(value.engineUsed).toBe('native-svg');
    expect(poppler('pdftotext', value.buffer)).toContain('Harbour survey');
    // 400 x 200 CSS pixels are 300 x 150 points.
    expect(poppler('pdfinfo', value.buffer)).toMatch(/Page size:\s+300 x 150 pts/);
  }, NATIVE_TIMEOUT_MS);

  it('svg -> pdf: a drawing the renderer rejects is still the typed error that names the renderer', async () => {
    const run = dispatchConversion(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect'), 'svg', 'pdf', {}, 'broken.svg');
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.toThrow(/^The SVG renderer rejected the drawing/);
  }, NATIVE_TIMEOUT_MS);

  it('eps -> pdf: the helper starts the interpreter once, and the page is the one ps2pdf writes', async () => {
    const { value, programs } = await launched(() => dispatchConversion(Buffer.from(EPS, 'latin1'), 'eps', 'pdf', {}, 'figure.eps'));
    expect(programs).toBe(1);
    expect(value.mimeType).toBe('application/pdf');
    const reference = inTempDir((dir) => {
      fs.writeFileSync(path.join(dir, 'in.eps'), EPS);
      execFileSync(requireOracleTool('ps2pdf'), ['-dSAFER', '-dEPSCrop', path.join(dir, 'in.eps'), path.join(dir, 'ref.pdf')]);
      return fs.readFileSync(path.join(dir, 'ref.pdf'));
    });
    const info = (pdf: Buffer): string[] | null => poppler('pdfinfo', pdf).match(/(Page size|Pages|PDF version):.*/g);
    expect(info(value.buffer)).toEqual(info(reference));
    expect(poppler('pdftotext', value.buffer)).toContain('EPS direct');
  }, NATIVE_TIMEOUT_MS);

  it('eps -> png: the helper starts the interpreter once, and the pixels are the interpreter\'s own PNG', async () => {
    const { value, programs } = await launched(() => dispatchConversion(Buffer.from(EPS, 'latin1'), 'eps', 'png', { dpi: DPI }, 'figure.eps'));
    expect(programs).toBe(1);
    expect(value.mimeType).toBe('image/png');
    const ours = decodeRgba(value.buffer, 'png');
    const theirs = decodeRgba(referencePng(EPS, DPI), 'png');
    expect([ours.width, ours.height]).toEqual([theirs.width, theirs.height]);
    expect(ours.data.equals(theirs.data)).toBe(true);
  }, NATIVE_TIMEOUT_MS);

  it('eps -> png: a page above the raw-size limit is stopped at the limit and drawn through the PDF route', async () => {
    // 4000 x 4000 points at 150 dpi is about 8333 x 8333 pixels: 208 MB of raw RGB, above the 128 MB limit.
    const large = '%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 4000 4000\n%%EndComments\n0.8 0.1 0.1 setrgbcolor 0 0 2000 2000 rectfill\nshowpage\n';
    const { value, programs } = await launched(() => dispatchConversion(Buffer.from(large, 'latin1'), 'eps', 'png', { dpi: 150 }, 'large.eps'));
    expect(programs).toBeGreaterThanOrEqual(2);
    expect({ width: value.buffer.readUInt32BE(16), height: value.buffer.readUInt32BE(20) }).toEqual({ width: 8334, height: 8334 });
  }, NATIVE_TIMEOUT_MS);

  it('eps -> png: a file the interpreter rejects is a typed 400 error naming what it found', async () => {
    const run = dispatchConversion(Buffer.from('%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\n(', 'latin1'), 'eps', 'png', { dpi: DPI }, 'broken.eps');
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.toThrow(/PostScript interpreter rejected the \.eps file/);
  }, NATIVE_TIMEOUT_MS);
});
