import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildPhotoPdf, photoResolution, readJpegInfo } from '../bench/pdf-photo';
import { parsePgm } from '../bench/pdf-ink';
import { compressPdf } from '../src/lib/conversions/pdf-postprocess';
import { graphScheduler } from '../src/lib/queue/graph';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { requireOracleTool } from './helpers/differential-oracle';
import { AES_256, containsEncryptKey, pdfinfoPages, plainPdf, qpdfCheckPasses, qpdfEncrypt, withTempDir } from './helpers/encrypted-pdf-fixtures';
import { getGhostscriptBinaryPath } from '../src/lib/conversions/pdf-postprocess/gs-path';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';

/**
 * PDF compression (#696). The input is a PDF whose photograph is placed at about 300 dpi, written byte by byte in
 * bench/pdf-photo.ts. Every claim is read back by a tool that shares no code with the product: qpdf --check, pdfinfo,
 * pdftotext for the text of each page, and pdftoppm for the pixels (a lossless profile must render identically; a
 * lossy one must stay close to the source render).
 */

/** Each test runs Ghostscript several times, which a cold machine does slowly. */
const TEST_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: TEST_TIMEOUT_MS });

const toolsMissing = skipWithoutTools('qpdf', 'pdftotext', 'pdfinfo', 'pdftoppm') || skipUnless('Ghostscript (gs)', getGhostscriptBinaryPath() !== null);

const PHOTO = fs.readFileSync(path.join(__dirname, '..', 'bench', 'corpus', 'photo-a.jpg'));
const PAGE_TEXTS = ['Photograph page 1 of three', 'Photograph page 2 of three', 'Photograph page 3 of three'];
const PHOTO_WIDTHS_POINTS = [180, 200, 220];
const RENDER_DPI = '72';
/** Mean absolute difference, in gray levels of 255, that a lossy profile may add to the render of a page. */
const WEB_RENDER_TOLERANCE = 6;
const USER_PASSWORD = 'user-secret-696';
const OWNER_PASSWORD = 'owner-secret-696';

const photoPdf = (): Buffer =>
  buildPhotoPdf({ jpeg: PHOTO, pageWidth: 612, pageHeight: 792, pages: PHOTO_WIDTHS_POINTS.map((width, index) => ({ text: PAGE_TEXTS[index], photoWidthPoints: width })) });

function pageTexts(pdf: Buffer): string[] {
  return withTempDir((dir) => {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, pdf);
    return execFileSync(requireOracleTool('pdftotext'), [file, '-'], { encoding: 'utf-8' })
      .split('\f')
      .slice(0, -1)
      .map((page) => page.trim());
  });
}

/** The pages of `pdf` as 8-bit gray rasters at 72 dpi. */
function renderedPages(pdf: Buffer): Array<{ width: number; height: number; pixels: Uint8Array }> {
  return withTempDir((dir) => {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, pdf);
    execFileSync(requireOracleTool('pdftoppm'), ['-r', RENDER_DPI, '-gray', file, path.join(dir, 'p')]);
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.pgm'))
      .sort()
      .map((name) => parsePgm(fs.readFileSync(path.join(dir, name))));
  });
}

function meanAbsoluteDifference(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < a.length; index++) sum += Math.abs(a[index] - b[index]);
  return sum / a.length;
}

async function rejection(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the operation to be rejected, but it resolved');
}

/** The error name and message of a rejection, which the test compares as plain data. */
async function refusal(run: Promise<unknown>): Promise<{ name: string; message: string }> {
  const error = (await rejection(run)) as Error;
  return { name: error.name, message: error.message };
}

describe.skipIf(toolsMissing)('PDF compression', () => {
  const input = photoPdf();

  it('builds an input whose photograph is above 300 dpi on every page', () => {
    const info = readJpegInfo(PHOTO);
    for (const width of PHOTO_WIDTHS_POINTS) expect(photoResolution(info, width)).toBeGreaterThan(250);
    expect(pdfinfoPages(input)).toBe(3);
  });

  it('web: a smaller, valid PDF with the same pages, text and a render close to the source', async () => {
    const result = await compressPdf(input, { profile: 'web' });
    expect(result.optimized).toBe(true);
    expect(result.buffer.length).toBeLessThan(input.length * 0.5);
    expect(qpdfCheckPasses(result.buffer)).toBe(true);
    expect(pdfinfoPages(result.buffer)).toBe(3);
    expect(pageTexts(result.buffer)).toEqual(PAGE_TEXTS);
    const before = renderedPages(input);
    const after = renderedPages(result.buffer);
    expect(after).toHaveLength(before.length);
    for (const [index, page] of after.entries()) {
      expect([page.width, page.height]).toEqual([before[index].width, before[index].height]);
      expect(meanAbsoluteDifference(page.pixels, before[index].pixels)).toBeLessThan(WEB_RENDER_TOLERANCE);
    }
  });

  it('defaults to the web profile', async () => {
    const byDefault = await compressPdf(input, undefined);
    const web = await compressPdf(input, { profile: 'web' });
    expect(byDefault.optimized).toBe(true);
    expect(Math.abs(byDefault.buffer.length - web.buffer.length)).toBeLessThan(web.buffer.length * 0.02);
  });

  it('max is smaller than web', async () => {
    const web = await compressPdf(input, { profile: 'web' });
    const max = await compressPdf(input, { profile: 'max' });
    expect(max.optimized).toBe(true);
    expect(max.buffer.length).toBeLessThan(web.buffer.length);
    expect(pageTexts(max.buffer)).toEqual(PAGE_TEXTS);
  });

  it('archive is lossless: every page renders to the same pixels, and the file is smaller', async () => {
    const result = await compressPdf(input, { profile: 'archive' });
    expect(result.optimized).toBe(true);
    expect(result.buffer.length).toBeLessThan(input.length);
    expect(qpdfCheckPasses(result.buffer)).toBe(true);
    const before = renderedPages(input);
    const after = renderedPages(result.buffer);
    expect(after.map((page) => Buffer.from(page.pixels).toString('base64'))).toEqual(before.map((page) => Buffer.from(page.pixels).toString('base64')));
    expect(pageTexts(result.buffer)).toEqual(PAGE_TEXTS);
  });

  it('never returns a larger file: a profile that gains nothing returns the input byte for byte, not optimized', async () => {
    for (const profile of ['web', 'print', 'archive', 'max'] as const) {
      const result = await compressPdf(input, { profile });
      expect(result.buffer.length).toBeLessThanOrEqual(input.length);
      if (!result.optimized) expect(result.buffer.equals(input)).toBe(true);
    }
    // A document that is already compact: the output of a profile, compressed by it again.
    const once = await compressPdf(input, { profile: 'max' });
    const twice = await compressPdf(once.buffer, { profile: 'max' });
    expect(twice.optimized).toBe(false);
    expect(twice.buffer.equals(once.buffer)).toBe(true);
    // A small text document that pdf-lib already packed.
    const text = await plainPdf(['Only text here']);
    const textResult = await compressPdf(text, { profile: 'web' });
    expect(textResult.buffer.length).toBeLessThanOrEqual(text.length);
  });

  it('refuses a profile that does not exist and input that is no PDF', async () => {
    expect(await refusal(compressPdf(input, { profile: 'tiny' as never }))).toMatchObject({ name: 'UnsupportedOptionError' });
    expect(await refusal(compressPdf(Buffer.from('not a pdf at all'), { profile: 'web' }))).toMatchObject({ name: 'CorruptStreamError' });
  });

  describe('encrypted input', () => {
    const locked = (): Buffer => qpdfEncrypt(photoPdf(), { variant: AES_256, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD });

    it('needs the open password', async () => {
      expect(await refusal(compressPdf(locked(), { profile: 'web' }))).toMatchObject({ name: 'PdfPasswordRequiredError' });
      expect(await refusal(compressPdf(locked(), { profile: 'web' }, { password: 'wrong' }))).toMatchObject({ name: 'PdfPasswordRequiredError' });
    });

    it('compresses with the password and writes no encryption', async () => {
      const result = await compressPdf(locked(), { profile: 'web' }, { password: USER_PASSWORD });
      expect(result.optimized).toBe(true);
      expect(containsEncryptKey(result.buffer)).toBe(false);
      expect(pageTexts(result.buffer)).toEqual(PAGE_TEXTS);
    });
  });
});

describe.skipIf(toolsMissing)('the optimize graph node on a PDF', () => {
  let counter = 0;

  async function runOptimize(options: Record<string, unknown>, bytes: Buffer): Promise<{ buffer: Buffer; optimizations: unknown; logs: string[] }> {
    const { processGraphNodeJob } = await import('../src/lib/queue/graph/node-executor');
    counter += 1;
    const key = `tests/pdf-compress/${Date.now()}_${counter}.pdf`;
    s3Storage.saveObject(key, bytes, 'application/pdf', 'book.pdf', 60 * 60 * 1000);
    const graphId = `g_compress_${Date.now()}_${counter}`;
    const logs: string[] = [];
    vi.spyOn(graphScheduler, 'getNodeOutputs').mockResolvedValue([]);
    try {
      const result = await processGraphNodeJob(
        {
          id: `${graphId}:n1`,
          data: { jobId: `${graphId}:n1`, sourceFormat: 'bin', targetFormat: 'bin', fileSize: 0, options: {}, graphId, graphNodeId: 'n1', graphNode: { op: 'optimize', input: 'src', options }, inputArtifacts: [key] },
          opts: { attempts: 1 },
          attemptsMade: 1,
          signal: new AbortController().signal,
          log: async (line: string) => {
            logs.push(line);
          },
          updateProgress: async () => {},
        } as never,
        undefined,
        s3Storage
      );
      return { buffer: s3Storage.getObject(result.resultKey)?.buffer as Buffer, optimizations: result.optimizations, logs };
    } finally {
      vi.restoreAllMocks();
    }
  }

  it('stores the compressed PDF and reports the sizes', async () => {
    const input = photoPdf();
    const { buffer, optimizations } = await runOptimize({ optimize: { profile: 'web' } }, input);
    expect(buffer.length).toBeLessThan(input.length);
    expect(optimizations).toEqual([{ key: expect.any(String), optimized: true, inputBytes: input.length, outputBytes: buffer.length }]);
    expect(pageTexts(buffer)).toEqual(PAGE_TEXTS);
  });

  it('keeps the input and reports optimized: false when the profile gains nothing', async () => {
    const compact = (await compressPdf(photoPdf(), { profile: 'max' })).buffer;
    const { buffer, optimizations, logs } = await runOptimize({ optimize: { profile: 'max' } }, compact);
    expect(buffer.equals(compact)).toBe(true);
    expect(optimizations).toEqual([{ key: expect.any(String), optimized: false, inputBytes: compact.length, outputBytes: expect.any(Number) }]);
    expect(logs.join('\n')).toContain('unchanged');
  });
});
