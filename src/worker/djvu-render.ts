import fs from 'node:fs';
import path from 'node:path';
import { readDjvuDocument } from '../lib/conversions/djvu-container';
import { stageTimeoutMs } from '../lib/conversions/job-time';
import { OFFICE_PAGE_IMAGE_MAX_PAGES } from '../lib/conversions/page-range';
import { launchSandboxedBinary, type LaunchedExecutionOptions } from '../lib/security/sandbox-launcher';
import { ConversionFailedError } from '../lib/types';
import { boundRenderedPages, selectsPages } from './poppler-ppm';
import { SandboxedBufferLimitError, SandboxedMemoryLimitError, SandboxedProcessError } from './sandbox';
import { createConversionResult, drawnPdfTooLargeError, handOffOutput, MAX_DRAWN_PDF_BYTES_FOR_IMAGES, readRawInputBuffer, withSandboxDir } from './worker-output';
import type { WorkerConversionResult, WorkerEngineOptions } from './worker-types';
import type { XpsJob } from './xps-render';

/**
 * DjVu documents are drawn by `ddjvu` of djvulibre (GPL-2.0-or-later, an unmodified separate program from the
 * `djvulibre-bin` package) into a PDF, which the native PDF tools take to every page target, as GhostXPS's PDF is taken.
 * The program decodes each page (IW44 wavelet background, JB2 bilevel mask, foreground colours) to a raster and writes
 * it with libtiff into a temporary TIFF beside the output, which `tiff2pdf` (compiled into the program,
 * tools/ddjvu.cpp `closefile`, lines 646 to 700) turns into a PDF of one image per page. The PDF holds no text layer; the
 * hidden text of the DjVu file is not carried into it, as the program does not carry it.
 *
 * The file is read for its structure first (djvu-container.ts): a document that names other files is refused, because
 * the program would read them from the directory of the file (libdjvu/DjVuDocument.cpp line 1531), and the pages and
 * their sizes are counted against the limits. The program then runs in a directory of its own that holds the one file
 * and the output, in the sandbox, without network.
 *
 * The program stops at the first page it cannot decode, with a message and the exit status 10 (tools/ddjvu.cpp
 * `dopage`, lines 728 to 746, unless `-skip` is given, which is not), so a truncated or damaged page is a failure here and
 * never a PDF with a missing page. A PDF is also a failure unless it holds as many pages as the document lists.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/**
 * Address space, output file size and output pipe limits of the other page chains (xps-render.ts, postscript-render.ts). Measured with
 * ddjvu 3.5.28 under an address space limit of 2 GiB: a 100 megapixel colour page (the pixel limit of the image inputs) peaks at
 * 672 MB resident and writes 145 MB of PDF in 5.6 s on the 4 vCPU Linux arm64 test VM.
 */
const MEMORY_LIMIT_MB = 2048;
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const PAGE_COUNT_DEFAULT_TIMEOUT_MS = 45_000;
const PAGE_COUNT_MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER_BYTES = 100 * 1024 * 1024;
const MAX_STDERR_CHARS = 300;
/** The program writes its result to a file in the job directory and prints nothing the worker has to copy. */
const NO_PIPED_OUTPUT_BYTES = 0;
/** `ddjvu -format=pdf <input> <output>`: the page range, the scale and the quality are left at the defaults (full page size, deflate). */
const FORMAT_FLAG = '-format=pdf';
const PDF_TARGET = 'pdf';
const TEMP_PREFIX = 'easyconvert-djvu-';
const INPUT_FILE = 'document.djvu';
const PDF_FILE = 'rendered.pdf';

/** The same job as GhostXPS's: the request, the program, and the PDF tools the drawn file is handed to. */
export type DjvuJob = Pick<XpsJob, 'input' | 'src' | 'tgt' | 'options' | 'originalFilename' | 'interpreter' | 'convertPdfPages' | 'countPdfPages'>;

/** The run limit of the job: its own stage limit, or the default, and never more than the ceiling. */
function runTimeoutMs(options: WorkerEngineOptions): number {
  return Math.min(stageTimeoutMs(options, DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

function rejected(src: string, stderr: string, tempDir: string): ConversionFailedError {
  const detail = stderr.trim().slice(0, MAX_STDERR_CHARS).replaceAll(tempDir, '<tmp>');
  return new ConversionFailedError(`ddjvu could not draw the .${src} file${detail ? `: ${detail}` : ''}`);
}

/** The typed error for a run that failed: its limits, or what the program printed about the file. */
function toRendererError(err: unknown, src: string, tempDir: string): unknown {
  if (err instanceof SandboxedBufferLimitError || err instanceof SandboxedMemoryLimitError) {
    return new ConversionFailedError(`ddjvu exceeded its output or memory limit on the .${src} file.`);
  }
  if (err instanceof SandboxedProcessError) return rejected(src, err.stderr, tempDir);
  return err;
}

async function writePdf(job: DjvuJob, bytes: Buffer, tempDir: string, expected: { maxBytes: number; pageCount: number }): Promise<string> {
  const inputPath = path.join(tempDir, INPUT_FILE);
  const pdfPath = path.join(tempDir, PDF_FILE);
  fs.writeFileSync(inputPath, bytes, { mode: 0o600 });
  const limits: LaunchedExecutionOptions = {
    timeoutMs: runTimeoutMs(job.options),
    maxBuffer: job.options.maxBufferBytes || DEFAULT_MAX_BUFFER_BYTES,
    maxFileSize: MAX_OUTPUT_BYTES,
    memoryLimitMb: MEMORY_LIMIT_MB,
    networkIsolated: true,
    signal: job.options.signal,
    cwd: tempDir,
    expectedOutputBytes: NO_PIPED_OUTPUT_BYTES,
  };
  try {
    await launchSandboxedBinary(job.interpreter, [FORMAT_FLAG, inputPath, pdfPath], limits);
  } catch (err) {
    throw toRendererError(err, job.src, tempDir);
  }
  const size = fs.existsSync(pdfPath) ? fs.statSync(pdfPath).size : 0;
  if (size === 0) throw new ConversionFailedError(`ddjvu drew no page from the .${job.src} file.`);
  if (size > expected.maxBytes) throw drawnPdfTooLargeError('ddjvu', job.src, size, expected.maxBytes);
  const pageTimeoutMs = Math.min(stageTimeoutMs(job.options, PAGE_COUNT_DEFAULT_TIMEOUT_MS), PAGE_COUNT_MAX_TIMEOUT_MS);
  const drawn = await job.countPdfPages(pdfPath, tempDir, pageTimeoutMs, job.options.signal);
  if (drawn !== expected.pageCount) {
    throw new ConversionFailedError(`ddjvu drew ${drawn} of the ${expected.pageCount} pages that the .${job.src} file lists.`);
  }
  return pdfPath;
}

function baseNameOf(job: DjvuJob): string {
  return job.originalFilename ? job.originalFilename.replace(/\.[^/.]+$/, '') : 'converted';
}

/**
 * Draws a DjVu document as a PDF and, for page targets, hands the PDF to the native PDF tools with the page limit of the
 * other document page chains. A request for the images of every page of a document longer than that limit is refused
 * before the document is drawn.
 */
export async function convertDjvu(job: DjvuJob): Promise<WorkerConversionResult | null> {
  const { input, tgt, options, originalFilename } = job;
  const bytes = readRawInputBuffer(input);
  const startTime = Date.now();
  const { pages } = readDjvuDocument(bytes);
  const pageOptions: WorkerEngineOptions = { ...options, maxRenderedPages: OFFICE_PAGE_IMAGE_MAX_PAGES };
  if (tgt !== PDF_TARGET && !selectsPages(options)) {
    boundRenderedPages(
      Array.from({ length: pages.length }, (_, index) => index + 1),
      pageOptions
    );
  }

  if (tgt === PDF_TARGET) {
    return withSandboxDir(TEMP_PREFIX, async (tempDir) => {
      const pdfPath = await writePdf(job, bytes, tempDir, { maxBytes: MAX_OUTPUT_BYTES, pageCount: pages.length });
      const persistedPath = handOffOutput(pdfPath, PDF_TARGET, options, Buffer.isBuffer(input) ? undefined : input);
      return createConversionResult(persistedPath, PDF_TARGET, baseNameOf(job), 'native-djvu', Date.now() - startTime);
    });
  }
  const pdf = await withSandboxDir(TEMP_PREFIX, async (tempDir) =>
    fs.readFileSync(await writePdf(job, bytes, tempDir, { maxBytes: MAX_DRAWN_PDF_BYTES_FOR_IMAGES, pageCount: pages.length }))
  );
  return job.convertPdfPages(pdf, tgt, pageOptions, originalFilename);
}
