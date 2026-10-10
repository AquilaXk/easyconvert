import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { ConversionFailedError, OcrEngineUnavailableError, PayloadLimitError, UnsupportedOptionError } from '../types';
import {
  executeSandboxedBinary,
  SandboxedBufferLimitError,
  SandboxedMemoryLimitError,
  SandboxedProcessError,
  SandboxedTimeoutError,
} from '../security/process-sandbox';
import { crc32 } from './crc32';
import { assertInputPixels } from './image-input-limits';
import { OCR_DEFAULT_DPI, OCR_MAX_DPI, OCR_MIN_RENDER_DPI } from './ocr-dpi';
import { readPdfPageFrames, renderedSizePixels, type PdfPageFrame, type RenderedPdfPage } from './pdf-page-geometry';
import { assertPdfImagesWithinLimit } from './pdf-rasterizer';

/**
 * Renders PDF pages to images for OCR with Poppler's `pdftoppm`, an external executable run under the process
 * sandbox (no Poppler code is used here). A scanned page is recognized as it is displayed, not as the image
 * objects it happens to hold: the render applies the content stream's matrices, /Rotate, the CropBox, image masks
 * and clipping, and puts vector text and images on one page. The pages come back as gray PNG files at the requested
 * resolution, with the resolution recorded in them, so the searchable PDF text layer is sized from the render.
 * pdftoppm is asked for the raw gray pixels (PGM) and the PNG is written here with the cheapest compression setting:
 * its own PNG encoder takes about nine tenths of the time of a letter-size scan at 300 dpi (0.7 s of 0.8 s), and the
 * file is decoded again as soon as the OCR reads it. The pixels are the ones pdftoppm draws.
 *
 * Every size is bounded before a page is drawn: the render's pixel count and the pixels of every image the PDF
 * holds against the image input limit (413), the number of pages against OCR_MAX_RENDERED_PAGES (413) and the
 * resolution against OCR_MAX_DPI (400).
 */

/** Most pages one request may render for OCR; each is a full page raster, so the count bounds the work. */
export const OCR_MAX_RENDERED_PAGES = 500;
/** One page that has not rendered in this time is stuck, not slow. */
export const OCR_RENDER_TIMEOUT_MS = 60_000;
/** Resident memory limit for one pdftoppm run; the sandbox kills the process group above it. */
export const OCR_RENDER_MEMORY_LIMIT_MB = 2048;
/** Diagnostics pdftoppm may print per page; more is runaway output. */
const RENDER_MAX_DIAGNOSTIC_BYTES = 1024 * 1024;
/** A rendered file is at most this many bytes per pixel (8-bit gray PGM) plus the header. */
const RENDER_MAX_BYTES_PER_PIXEL = 1;
const RENDER_FILE_OVERHEAD_BYTES = 64 * 1024;
const RENDER_JOB_DIR_PREFIX = 'easyconvert-ocr-pages-';
const RENDER_INPUT_NAME = 'input.pdf';
const RENDER_OUTPUT_BASE = 'page';
/** The header pdftoppm writes for an 8-bit gray page: `P5`, width, height and the largest sample value. */
const PGM_HEADER = /^P5\s+(\d+)\s+(\d+)\s+255\s/;
/** Zlib level of the PNG handed to the OCR: it is decoded again at once, so the time spent compressing it is lost. */
const RENDER_PNG_COMPRESSION_LEVEL = 1;
const PNG_SIGNATURE_BYTES = 8;
const PNG_IHDR_CHUNK_BYTES = 25;
const PNG_CHUNK_OVERHEAD_BYTES = 12;
const PHYS_DATA_BYTES = 9;
const PHYS_UNIT_METRE = 1;
const METRES_PER_INCH = 0.0254;
const PDFTOPPM_CANDIDATES = ['/usr/bin/pdftoppm', '/usr/local/bin/pdftoppm', '/opt/homebrew/bin/pdftoppm'];
const INCORRECT_PASSWORD = /incorrect password/i;
const DIAGNOSTIC_LOGGED_CHARS = 500;

interface GrayPage {
  width: number;
  height: number;
  pixels: Buffer;
}

/**
 * The PNG with a single `pHYs` chunk (ISO/IEC 15948 section 11.3.5.3) that records `dpi` on both axes, placed right
 * after IHDR. The image library writes a density of its own (1000 pixels per metre, 25.4 dpi) and writes a density
 * of the caller's only together with a colour profile, which turns a gray page into RGB; so its chunk is dropped and
 * ours put in its place, and a reader that takes the first or the last chunk sees the same resolution.
 */
function withPngDensity(png: Buffer, dpi: number): Buffer {
  const chunk = Buffer.alloc(PNG_CHUNK_OVERHEAD_BYTES + PHYS_DATA_BYTES);
  const pixelsPerMetre = Math.round(dpi / METRES_PER_INCH);
  chunk.writeUInt32BE(PHYS_DATA_BYTES, 0);
  chunk.write('pHYs', 4, 'latin1');
  chunk.writeUInt32BE(pixelsPerMetre, 8);
  chunk.writeUInt32BE(pixelsPerMetre, 12);
  chunk[16] = PHYS_UNIT_METRE;
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 17)), 17);
  const afterHeader = PNG_SIGNATURE_BYTES + PNG_IHDR_CHUNK_BYTES;
  const parts: Buffer[] = [png.subarray(0, afterHeader), chunk];
  let offset = afterHeader;
  while (offset + PNG_CHUNK_OVERHEAD_BYTES <= png.length) {
    const end = offset + PNG_CHUNK_OVERHEAD_BYTES + png.readUInt32BE(offset);
    if (png.toString('latin1', offset + 4, offset + 8) !== 'pHYs') parts.push(png.subarray(offset, end));
    offset = end;
  }
  return Buffer.concat(parts);
}

/** The page of a binary 8-bit PGM file, or null when the file is not one or its pixels are not as many as its header says. */
function parseGrayPgm(file: Buffer): GrayPage | null {
  const header = PGM_HEADER.exec(file.toString('latin1', 0, 64));
  if (!header) return null;
  const width = Number(header[1]);
  const height = Number(header[2]);
  const pixels = file.subarray(header[0].length);
  if (width < 1 || height < 1 || pixels.length !== width * height) return null;
  return { width, height, pixels };
}

function findPdftoppm(): string | undefined {
  const fromEnvironment = process.env.PDFTOPPM_PATH;
  if (fromEnvironment && fs.existsSync(fromEnvironment)) return fromEnvironment;
  return PDFTOPPM_CANDIDATES.find((candidate) => fs.existsSync(candidate));
}

/** The resolution to render at: the request's `dpi`, OCR_DEFAULT_DPI when unset, and a client error when out of range. */
export function resolveRenderDpi(requested: number | undefined): number {
  if (requested === undefined) return OCR_DEFAULT_DPI;
  if (!Number.isFinite(requested) || requested < OCR_MIN_RENDER_DPI || requested > OCR_MAX_DPI) {
    throw new UnsupportedOptionError(
      `Invalid dpi for OCR page rendering: ${String(requested)}. Allowed: ${OCR_MIN_RENDER_DPI} to ${OCR_MAX_DPI}.`
    );
  }
  return Math.round(requested);
}

export interface RenderedOcrPage {
  /** 1-based page number in the PDF. */
  pageNumber: number;
  /** The page as a gray PNG. */
  image: Buffer;
  /** How the image relates to the PDF page: frame, resolution and size in pixels. */
  page: RenderedPdfPage;
}

/** What a caller sees of one page: the PDF's frame for it, before anything is drawn. */
export interface RenderPlan {
  pageNumbers: number[];
  frames: PdfPageFrame[];
  dpi: number;
}

/**
 * Checks the pages and resolution against every limit before any page is drawn, and returns the frames of the
 * requested pages (all pages when `pages` is undefined).
 */
export async function planPageRender(pdf: Buffer, pages: ReadonlySet<number> | undefined, requestedDpi: number | undefined): Promise<RenderPlan> {
  const dpi = resolveRenderDpi(requestedDpi);
  // The renderer decodes every image a page draws, so an image that declares more pixels than the input limit is
  // refused from its dictionary first (413), and one whose size cannot be read is refused as unreadable (400).
  assertPdfImagesWithinLimit(pdf);
  const frames = await readPdfPageFrames(pdf);
  const pageNumbers = (pages === undefined ? frames.map((_, index) => index + 1) : [...pages]).sort((a, b) => a - b);
  for (const pageNumber of pageNumbers) {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > frames.length) {
      throw new ConversionFailedError(`Page ${pageNumber} does not exist; the PDF has ${frames.length} page(s).`);
    }
  }
  if (pageNumbers.length > OCR_MAX_RENDERED_PAGES) {
    throw new PayloadLimitError(
      `OCR was asked to render ${pageNumbers.length} pages; at most ${OCR_MAX_RENDERED_PAGES} are rendered in one request. Select a page range.`
    );
  }
  for (const pageNumber of pageNumbers) {
    const { width, height } = renderedSizePixels(frames[pageNumber - 1], dpi);
    assertInputPixels(width, height);
  }
  return { pageNumbers, frames: pageNumbers.map((pageNumber) => frames[pageNumber - 1]), dpi };
}

function describeRenderFailure(err: unknown, pageNumber: number): Error {
  if (err instanceof SandboxedTimeoutError) {
    return new ConversionFailedError(`Page ${pageNumber} could not be rendered for OCR within ${OCR_RENDER_TIMEOUT_MS} ms.`);
  }
  if (err instanceof SandboxedMemoryLimitError || err instanceof SandboxedBufferLimitError) {
    return new PayloadLimitError(`Page ${pageNumber} needs more memory or output than rendering for OCR allows.`);
  }
  if (err instanceof SandboxedProcessError) {
    if (INCORRECT_PASSWORD.test(err.stderr)) {
      return new ConversionFailedError('PDF OCR failed: the PDF is encrypted and needs a password, so its pages cannot be rendered.');
    }
    console.warn(`[ocr] pdftoppm failed on page ${pageNumber}: ${err.stderr.replace(/\s+/g, ' ').trim().slice(0, DIAGNOSTIC_LOGGED_CHARS)}`);
    return new ConversionFailedError(`Page ${pageNumber} could not be rendered for OCR: the PDF is malformed or unsupported.`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** A reader for the pages of one PDF, drawing each on demand into a private directory that `close` removes. */
export interface PdfPageRenderer {
  plan: RenderPlan;
  /** Draws page `plan.pageNumbers[index]`; the page is not kept after the call returns. */
  render(index: number): Promise<RenderedOcrPage>;
  close(): Promise<void>;
}

/**
 * Opens a renderer for the requested pages. Without Poppler's pdftoppm the request cannot be served here and is an
 * OcrEngineUnavailableError (503): the pages are not read from the image objects as a substitute, because that would
 * recognize something other than the page.
 */
export async function openPdfPageRenderer(
  pdf: Buffer,
  pages: ReadonlySet<number> | undefined,
  requestedDpi: number | undefined
): Promise<PdfPageRenderer> {
  const plan = await planPageRender(pdf, pages, requestedDpi);
  const pdftoppm = findPdftoppm();
  if (!pdftoppm) {
    throw new OcrEngineUnavailableError('Rendering PDF pages for OCR needs Poppler pdftoppm, which is not installed on this server.');
  }
  const jobDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), RENDER_JOB_DIR_PREFIX));
  const inputPath = path.join(jobDir, RENDER_INPUT_NAME);
  try {
    await fs.promises.writeFile(inputPath, pdf, { mode: 0o600 });
  } catch (err) {
    await fs.promises.rm(jobDir, { recursive: true, force: true });
    throw err;
  }
  return {
    plan,
    async render(index: number): Promise<RenderedOcrPage> {
      const pageNumber = plan.pageNumbers[index];
      const frame = plan.frames[index];
      const expected = renderedSizePixels(frame, plan.dpi);
      const outputBase = path.join(jobDir, `${RENDER_OUTPUT_BASE}-${pageNumber}`);
      const args = ['-gray', '-cropbox', '-singlefile', '-r', String(plan.dpi), '-f', String(pageNumber), '-l', String(pageNumber), inputPath, outputBase];
      try {
        await executeSandboxedBinary(pdftoppm, args, {
          cwd: jobDir,
          timeoutMs: OCR_RENDER_TIMEOUT_MS,
          maxBuffer: RENDER_MAX_DIAGNOSTIC_BYTES,
          maxFileSize: expected.width * expected.height * RENDER_MAX_BYTES_PER_PIXEL + RENDER_FILE_OVERHEAD_BYTES,
          memoryLimitMb: OCR_RENDER_MEMORY_LIMIT_MB,
          networkIsolated: true,
        });
      } catch (err) {
        throw describeRenderFailure(err, pageNumber);
      }
      let file: Buffer;
      try {
        file = await fs.promises.readFile(`${outputBase}.pgm`);
      } catch {
        throw new OcrEngineUnavailableError(`pdftoppm produced no image for page ${pageNumber}.`);
      } finally {
        await fs.promises.rm(`${outputBase}.pgm`, { force: true });
      }
      const gray = parseGrayPgm(file);
      if (!gray) {
        throw new OcrEngineUnavailableError(`pdftoppm produced an unreadable image for page ${pageNumber}.`);
      }
      assertInputPixels(gray.width, gray.height);
      const encoded = await sharp(gray.pixels, { raw: { width: gray.width, height: gray.height, channels: 1 } })
        .toColourspace('b-w')
        .png({ compressionLevel: RENDER_PNG_COMPRESSION_LEVEL })
        .toBuffer();
      const image = withPngDensity(encoded, plan.dpi);
      return { pageNumber, image, page: { frame, dpi: plan.dpi, widthPx: gray.width, heightPx: gray.height } };
    },
    async close(): Promise<void> {
      await fs.promises.rm(jobDir, { recursive: true, force: true });
    },
  };
}
