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
import { assertInputPixels } from './image-input-limits';
import { OCR_DEFAULT_DPI, OCR_MAX_DPI, OCR_MIN_RENDER_DPI } from './ocr-dpi';
import { readPdfPageFrames, renderedSizePixels, type PdfPageFrame, type RenderedPdfPage } from './pdf-page-geometry';
import { assertPdfImagesWithinLimit } from './pdf-rasterizer';

/**
 * Renders PDF pages to images for OCR with Poppler's `pdftoppm`, an external executable run under the process
 * sandbox (no Poppler code is used here). A scanned page is recognized as it is displayed, not as the image
 * objects it happens to hold: the render applies the content stream's matrices, /Rotate, the CropBox, image masks
 * and clipping, and puts vector text and images on one page. The pages come back as gray PNG files at the requested
 * resolution; pdftoppm writes the resolution into them, so the searchable PDF text layer is sized from the render.
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
/** A rendered file is at most this many bytes per pixel (gray PNG, stored uncompressed in the worst case) plus the headers. */
const RENDER_MAX_BYTES_PER_PIXEL = 2;
const RENDER_FILE_OVERHEAD_BYTES = 64 * 1024;
const RENDER_JOB_DIR_PREFIX = 'easyconvert-ocr-pages-';
const RENDER_INPUT_NAME = 'input.pdf';
const RENDER_OUTPUT_BASE = 'page';
const PDFTOPPM_CANDIDATES = ['/usr/bin/pdftoppm', '/usr/local/bin/pdftoppm', '/opt/homebrew/bin/pdftoppm'];
const INCORRECT_PASSWORD = /incorrect password/i;
const DIAGNOSTIC_LOGGED_CHARS = 500;

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
      const args = ['-png', '-gray', '-cropbox', '-singlefile', '-r', String(plan.dpi), '-f', String(pageNumber), '-l', String(pageNumber), inputPath, outputBase];
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
      let image: Buffer;
      try {
        image = await fs.promises.readFile(`${outputBase}.png`);
      } catch {
        throw new OcrEngineUnavailableError(`pdftoppm produced no image for page ${pageNumber}.`);
      } finally {
        await fs.promises.rm(`${outputBase}.png`, { force: true });
      }
      const meta = await sharp(image).metadata();
      if (!meta.width || !meta.height) {
        throw new OcrEngineUnavailableError(`pdftoppm produced an unreadable image for page ${pageNumber}.`);
      }
      assertInputPixels(meta.width, meta.height);
      return { pageNumber, image, page: { frame, dpi: plan.dpi, widthPx: meta.width, heightPx: meta.height } };
    },
    async close(): Promise<void> {
      await fs.promises.rm(jobDir, { recursive: true, force: true });
    },
  };
}
