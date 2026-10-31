import fs from 'node:fs';
import path from 'node:path';
import { readDjvuContainer } from '../lib/conversions/djvu-container';
import { checkIncludeGraph } from '../lib/conversions/djvu-include-graph';
import { DJVUSED_DIRECTORY_SCRIPT, DJVUSED_MAX_OUTPUT_BYTES, DJVUSED_SIZE_SCRIPT, parseDjvusedDirectory, parseDjvusedSizes } from '../lib/conversions/djvu-report';
import { stageTimeoutMs } from '../lib/conversions/job-time';
import { groupConsecutiveRanges, OFFICE_PAGE_IMAGE_MAX_PAGES, resolvePageSelection } from '../lib/conversions/page-range';
import { launchSandboxedBinary, type LaunchedExecutionOptions } from '../lib/security/sandbox-launcher';
import { ConversionFailedError, EngineUnavailableError, InvalidPageRangeError } from '../lib/types';
import { boundRenderedPages } from './poppler-ppm';
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
 * The file is read for its structure first. The bytes are checked in djvu-container.ts (a document that names other files is
 * refused, because the program would read them from the directory of the file, libdjvu/DjVuDocument.cpp line 1531), then
 * `djvused` of the same package, run in the same sandbox on the same file, reports the page count and the directory
 * (djvu-report.ts), so that what the converter counts is what `ddjvu` draws; the include graph of a bundled document is checked
 * against that directory (djvu-include-graph.ts); and a second run of `djvused`, which crashes on the graphs that check refuses,
 * reports the page sizes, so that what the converter limits is what `ddjvu` draws. All three programs run before the output
 * exists, in a directory of their own that holds the one file and the output, in the sandbox, without network.
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
/**
 * The size limit of one file the program writes. It writes two: the temporary TIFF of every page, which `tiff2pdf` then turns
 * into the PDF, and the PDF, each under this limit. The TIFF of a colour page is about as large as the page's PDF image, so
 * the limit is met by the pages together: see entry 134 of docs/policy-decisions.md for what it allows.
 */
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const PAGE_COUNT_DEFAULT_TIMEOUT_MS = 45_000;
const PAGE_COUNT_MAX_TIMEOUT_MS = 120_000;
/** `djvused` reads the directory and the first chunks of the pages and prints a few lines for each. Its cost is that of the directory (9.5 s for the 20,000 files that are the most taken, djvu-container.ts), so it is given a short time. */
const REPORT_TIMEOUT_MS = 30_000;
/** What the report of a document of a few hundred pages comes to; the launcher helper copies it back. */
const REPORT_EXPECTED_OUTPUT_BYTES = 64 * 1024;
const REPORT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_BUFFER_BYTES = 100 * 1024 * 1024;
const MAX_STDERR_CHARS = 300;
/** The program writes its result to a file in the job directory and prints nothing the worker has to copy. */
const NO_PIPED_OUTPUT_BYTES = 0;
/** `ddjvu -format=pdf [-page=<pages>] <input> <output>`: the scale and the quality are left at the defaults (full page size, deflate). */
const FORMAT_FLAG = '-format=pdf';
const PDF_TARGET = 'pdf';
const TEMP_PREFIX = 'easyconvert-djvu-';
const INPUT_FILE = 'document.djvu';
const PDF_FILE = 'rendered.pdf';
const REPORT_PROGRAM = 'djvused';
const RENDER_PROGRAM = 'ddjvu';

/** The same job as GhostXPS's: the request, the program, and the PDF tools the drawn file is handed to. */
export type DjvuJob = Pick<XpsJob, 'input' | 'src' | 'tgt' | 'options' | 'originalFilename' | 'interpreter' | 'convertPdfPages' | 'countPdfPages'>;

/** The pages the program draws and the limit on the PDF it writes. */
interface DrawPlan {
  /** The `-page` argument, or undefined for every page. */
  readonly pageSpec: string | undefined;
  readonly pageCount: number;
  readonly maxBytes: number;
}

/** The run limit of the job: its own stage limit, or the default, and never more than the ceiling. */
function runTimeoutMs(options: WorkerEngineOptions): number {
  return Math.min(stageTimeoutMs(options, DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

function rejected(program: string, src: string, stderr: string, tempDir: string): ConversionFailedError {
  const detail = stderr.trim().slice(0, MAX_STDERR_CHARS).replaceAll(tempDir, '<tmp>');
  return new ConversionFailedError(`${program} could not ${program === RENDER_PROGRAM ? 'draw' : 'read'} the .${src} file${detail ? `: ${detail}` : ''}`);
}

/** The typed error for a run that failed: its limits, or what the program printed about the file. */
function toRendererError(err: unknown, program: string, src: string, tempDir: string): unknown {
  if (err instanceof SandboxedBufferLimitError || err instanceof SandboxedMemoryLimitError) {
    return new ConversionFailedError(`${program} exceeded its output or memory limit on the .${src} file.`);
  }
  if (err instanceof SandboxedProcessError) return rejected(program, src, err.stderr, tempDir);
  return err;
}

function sandboxLimits(job: DjvuJob, tempDir: string, limits: Pick<LaunchedExecutionOptions, 'timeoutMs' | 'maxBuffer' | 'maxFileSize' | 'expectedOutputBytes'>): LaunchedExecutionOptions {
  return { memoryLimitMb: MEMORY_LIMIT_MB, networkIsolated: true, signal: job.options.signal, cwd: tempDir, ...limits };
}

/** `djvused` ships in the package of `ddjvu` and sits next to it. */
function reportProgramOf(job: DjvuJob): string {
  const program = path.join(path.dirname(job.interpreter), REPORT_PROGRAM);
  if (!fs.existsSync(program)) throw new EngineUnavailableError(REPORT_PROGRAM, `${REPORT_PROGRAM} (djvulibre-bin) is not installed next to ${RENDER_PROGRAM}`);
  return program;
}

/** What `script` of `djvused` prints for the document, in the sandbox. */
async function runReport(job: DjvuJob, inputPath: string, tempDir: string, script: string): Promise<string> {
  const limits = sandboxLimits(job, tempDir, {
    timeoutMs: Math.min(runTimeoutMs(job.options), REPORT_TIMEOUT_MS),
    maxBuffer: DJVUSED_MAX_OUTPUT_BYTES,
    maxFileSize: REPORT_MAX_FILE_BYTES,
    expectedOutputBytes: REPORT_EXPECTED_OUTPUT_BYTES,
  });
  try {
    const run = await launchSandboxedBinary(reportProgramOf(job), ['-e', script, inputPath], limits);
    return run.stdout.toString('utf-8');
  } catch (err) {
    throw toRendererError(err, REPORT_PROGRAM, job.src, tempDir);
  }
}

/** The pages as the `-page` argument of the program: `3-5,8`. */
function pageSpecOf(pages: readonly number[]): string {
  return groupConsecutiveRanges([...pages]).map(({ start, end }) => (start === end ? String(start) : `${start}-${end}`)).join(',');
}

/** The request without its page selection, for the PDF of only the selected pages. */
function withoutPageSelection(options: WorkerEngineOptions): WorkerEngineOptions {
  return { ...options, page: undefined, pages: undefined };
}

/**
 * What to draw. A PDF target is every page. A page target is the pages the request selects, at most as many as the other page
 * chains render in one request (the whole document when none is selected), so that a long document is not drawn for one page.
 */
function drawPlanOf(job: DjvuJob, pageCount: number): DrawPlan {
  if (job.tgt === PDF_TARGET) return { pageSpec: undefined, pageCount, maxBytes: MAX_OUTPUT_BYTES };
  const selected =
    resolvePageSelection(job.options.page, job.options.pages, pageCount, (page, count) => new InvalidPageRangeError(`Page number ${page} is out of bounds (1-${count})`)) ??
    Array.from({ length: pageCount }, (_, index) => index + 1);
  const drawn = boundRenderedPages(selected, { ...job.options, maxRenderedPages: OFFICE_PAGE_IMAGE_MAX_PAGES });
  return { pageSpec: drawn.length === pageCount ? undefined : pageSpecOf(drawn), pageCount: drawn.length, maxBytes: MAX_DRAWN_PDF_BYTES_FOR_IMAGES };
}

async function writePdf(job: DjvuJob, inputPath: string, tempDir: string, plan: DrawPlan): Promise<string> {
  const pdfPath = path.join(tempDir, PDF_FILE);
  const limits = sandboxLimits(job, tempDir, {
    timeoutMs: runTimeoutMs(job.options),
    maxBuffer: job.options.maxBufferBytes || DEFAULT_MAX_BUFFER_BYTES,
    maxFileSize: MAX_OUTPUT_BYTES,
    expectedOutputBytes: NO_PIPED_OUTPUT_BYTES,
  });
  const pageArguments = plan.pageSpec === undefined ? [] : [`-page=${plan.pageSpec}`];
  try {
    await launchSandboxedBinary(job.interpreter, [FORMAT_FLAG, ...pageArguments, inputPath, pdfPath], limits);
  } catch (err) {
    throw toRendererError(err, RENDER_PROGRAM, job.src, tempDir);
  }
  const size = fs.existsSync(pdfPath) ? fs.statSync(pdfPath).size : 0;
  if (size === 0) throw new ConversionFailedError(`ddjvu drew no page from the .${job.src} file.`);
  if (size > plan.maxBytes) throw drawnPdfTooLargeError('ddjvu', job.src, size, plan.maxBytes);
  const pageTimeoutMs = Math.min(stageTimeoutMs(job.options, PAGE_COUNT_DEFAULT_TIMEOUT_MS), PAGE_COUNT_MAX_TIMEOUT_MS);
  const drawn = await job.countPdfPages(pdfPath, tempDir, pageTimeoutMs, job.options.signal);
  if (drawn !== plan.pageCount) {
    throw new ConversionFailedError(`ddjvu drew ${drawn} of the ${plan.pageCount} pages that the .${job.src} file lists.`);
  }
  return pdfPath;
}

function baseNameOf(job: DjvuJob): string {
  return job.originalFilename ? job.originalFilename.replace(/\.[^/.]+$/, '') : 'converted';
}

/**
 * Draws a DjVu document as a PDF and, for page targets, hands the PDF to the native PDF tools with the page limit of the
 * other document page chains. A request for the images of more pages than that limit, of every page of a long document or of a
 * long selection, is refused before anything is drawn. A selection is drawn alone (`ddjvu -page`), so the PDF holds the
 * selected pages and nothing else.
 */
export async function convertDjvu(job: DjvuJob): Promise<WorkerConversionResult | null> {
  const { input, tgt, options, originalFilename } = job;
  const bytes = readRawInputBuffer(input);
  const startTime = Date.now();
  const container = readDjvuContainer(bytes);
  const draw = async (tempDir: string): Promise<string> => {
    const inputPath = path.join(tempDir, INPUT_FILE);
    fs.writeFileSync(inputPath, bytes, { mode: 0o600 });
    const { pageCount, entries } = parseDjvusedDirectory(await runReport(job, inputPath, tempDir, DJVUSED_DIRECTORY_SCRIPT));
    if (container.bundle !== null) checkIncludeGraph(bytes, container.bundle, entries);
    // The sizes are only checked, against the pixel limit: ddjvu draws each page at its own size.
    parseDjvusedSizes(await runReport(job, inputPath, tempDir, DJVUSED_SIZE_SCRIPT), pageCount);
    return writePdf(job, inputPath, tempDir, drawPlanOf(job, pageCount));
  };

  if (tgt === PDF_TARGET) {
    return withSandboxDir(TEMP_PREFIX, async (tempDir) => {
      const pdfPath = await draw(tempDir);
      const persistedPath = handOffOutput(pdfPath, PDF_TARGET, options, Buffer.isBuffer(input) ? undefined : input);
      return createConversionResult(persistedPath, PDF_TARGET, baseNameOf(job), 'native-djvu', Date.now() - startTime);
    });
  }
  const pdf = await withSandboxDir(TEMP_PREFIX, async (tempDir) => fs.readFileSync(await draw(tempDir)));
  const pageOptions: WorkerEngineOptions = { ...withoutPageSelection(options), maxRenderedPages: OFFICE_PAGE_IMAGE_MAX_PAGES };
  return job.convertPdfPages(pdf, tgt, pageOptions, originalFilename);
}
