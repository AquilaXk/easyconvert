import fs from 'node:fs';
import path from 'node:path';
import { stageTimeoutMs } from '../lib/conversions/job-time';
import { ConversionFailedError } from '../lib/types';
import { parsePpmHeader, PPM_PAGE_MAX_BYTES, runPdftoppm } from './poppler-ppm';
import { withSandboxDir } from './worker-output';
import type { WorkerEngineOptions } from './worker-types';

/**
 * Whether the first page of a PDF holds anything but paper. The page is drawn by Poppler at 72 dpi as the worker draws every
 * page image (the raw PPM page, `poppler-ppm.ts`), and a page has ink when one byte of it is not white. Drawing is the
 * definition of ink here: a PDF that paints a white rectangle over the page, as the office suite's PDF does for a metafile it
 * could not draw, has no operator to tell it from a page of a real drawing without drawing it.
 */

const TEMP_PREFIX = 'easyconvert-pdf-ink-';
const INK_DPI = 72;
const PAGE_FILE = 'page';
const INPUT_FILE = 'input.pdf';
const PAGE_DEFAULT_TIMEOUT_MS = 45_000;
const PAGE_MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER_BYTES = 100 * 1024 * 1024;
const RGB_CHANNELS = 3;
const WHITE_BYTE = 0xff;
/** The raster is compared to white one chunk at a time with the native comparison, which stops at the first different chunk. */
const WHITE_CHUNK = Buffer.alloc(64 * 1024, WHITE_BYTE);

/** True when a byte of `bytes` from `from` on is not white. */
function hasNonWhiteByte(bytes: Buffer, from: number): boolean {
  for (let at = from; at < bytes.length; at += WHITE_CHUNK.length) {
    const end = Math.min(at + WHITE_CHUNK.length, bytes.length);
    if (bytes.compare(WHITE_CHUNK, 0, end - at, at, end) !== 0) return true;
  }
  return false;
}

/**
 * Draws page 1 of the PDF that `pdf` holds, by its file when it has one, and tells whether it has ink. A page whose raw raster
 * is above PPM_PAGE_MAX_BYTES (a page of more than 44 million square points) is not drawn: the renderer's file size limit stops it
 * and the failure is the answer, not a guess. A renderer that cannot read the PDF fails the same way.
 */
export async function pdfFirstPageHasInk(pdf: { filePath?: string; buffer: Buffer }, pdftoppm: string, options: WorkerEngineOptions): Promise<boolean> {
  return withSandboxDir(TEMP_PREFIX, async (tempDir) => {
    let inputPath = pdf.filePath;
    if (inputPath === undefined) {
      inputPath = path.join(tempDir, INPUT_FILE);
      fs.writeFileSync(inputPath, pdf.buffer);
    }
    const prefix = path.join(tempDir, PAGE_FILE);
    await runPdftoppm(pdftoppm, ['-r', String(INK_DPI), '-f', '1', '-l', '1', '-singlefile', inputPath, prefix], {
      cwd: tempDir,
      timeoutMs: Math.min(stageTimeoutMs(options, PAGE_DEFAULT_TIMEOUT_MS), PAGE_MAX_TIMEOUT_MS),
      maxBuffer: options.maxBufferBytes || DEFAULT_MAX_BUFFER_BYTES,
      maxFileSize: PPM_PAGE_MAX_BYTES,
      networkIsolated: true,
      signal: options.signal,
    });
    const rendered = fs.readFileSync(`${prefix}.ppm`);
    const { width, height, dataOffset } = parsePpmHeader(rendered);
    if (rendered.length - dataOffset !== width * height * RGB_CHANNELS) {
      throw new ConversionFailedError(`The PDF renderer wrote a page image of ${rendered.length - dataOffset} bytes for a page of ${width} x ${height} pixels.`);
    }
    return hasNonWhiteByte(rendered, dataOffset);
  });
}
